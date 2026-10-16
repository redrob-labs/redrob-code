//! The app bridge, from a Rust app.
//!
//! A Redrob desktop app hands the shared daemon its own tools in one call: [`AppBridge::start`]
//! serves the tools over MCP (streamable HTTP, JSON-RPC over `POST`) on `127.0.0.1` at a free
//! port, registers that server through `redrob-engine-client`'s `bridge_app` (which heartbeats and
//! re-registers after a daemon restart) and unregisters when the bridge is stopped or dropped. The
//! engine's `docs/APP-BRIDGE.md` has the contract.
//!
//! There is no async runtime: the server is a blocking loop on a std thread, each request handled
//! on a short-lived thread of its own, so an egui app calls this from its own setup code and keeps
//! the handle in its state.
//!
//! What the server speaks (the 2025-03-26 streamable HTTP transport, the parts a tool server
//! needs): `initialize`, `ping`, `tools/list`, `tools/call`; notifications and client responses
//! are acknowledged with `202`; `GET` (the optional server-to-client stream) is `405`. Every reply
//! is a plain `application/json` body -- no SSE, no session ids.

use std::io::Read;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

use serde::Deserialize;
use serde_json::{Value, json};

pub use redrob_engine_client::{AppRegisterInput, Record};

/// The MCP protocol revision this server answers `initialize` with.
pub const PROTOCOL_VERSION: &str = "2025-03-26";

/// What a tool's handler is: the call's `arguments` object in, the text the agent reads out.
/// `Err` becomes a tool result with `isError: true` (the agent sees the message and can recover),
/// not a JSON-RPC error.
pub type Handler = Arc<dyn Fn(Value) -> Result<String, String> + Send + Sync>;

/// One tool the app exposes.
#[derive(Clone)]
pub struct Tool {
    /// The app's own name for it; the engine shows it as `app:<app>` / `<name>`. Short, verb-first.
    pub name: String,
    pub description: String,
    /// JSON Schema for `arguments`. `Value::Null` means "an object, anything goes".
    pub input_schema: Value,
    pub handler: Handler,
}

impl Tool {
    pub fn new<F>(name: impl Into<String>, description: impl Into<String>, input_schema: Value, handler: F) -> Self
    where
        F: Fn(Value) -> Result<String, String> + Send + Sync + 'static,
    {
        Self { name: name.into(), description: description.into(), input_schema, handler: Arc::new(handler) }
    }

    fn descriptor(&self) -> Value {
        let schema = if self.input_schema.is_null() { json!({ "type": "object" }) } else { self.input_schema.clone() };
        json!({ "name": self.name, "description": self.description, "inputSchema": schema })
    }
}

impl std::fmt::Debug for Tool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tool").field("name", &self.name).field("description", &self.description).field("input_schema", &self.input_schema).finish()
    }
}

/// What [`AppBridge::start`] needs.
#[derive(Clone, Debug)]
pub struct AppBridgeConfig {
    /// The engine exposes the tools under MCP server `app:<name>`; also the `REDROB_APP` on a
    /// daemon this call has to start.
    pub name: String,
    /// Shown by `redrob apps list`; defaults to nothing. Apps pass `env!("CARGO_PKG_VERSION")`.
    pub version: Option<String>,
    pub tools: Vec<Tool>,
    /// How long a daemon started here stays up with nobody attached (`0` keeps it up). The
    /// bridge holds an attachment while it stands, so this only matters after the app quits.
    pub idle_exit_minutes: u32,
}

impl AppBridgeConfig {
    pub fn new(name: impl Into<String>, tools: Vec<Tool>) -> Self {
        Self { name: name.into(), version: None, tools, idle_exit_minutes: 10 }
    }
}

/// The MCP server the daemon reaches: one `tiny_http` server on a std thread, stopped on drop.
struct McpServer {
    server: Arc<tiny_http::Server>,
    addr: SocketAddr,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

/// What every request handler shares.
struct Shared {
    name: String,
    version: String,
    tools: Vec<Tool>,
}

impl McpServer {
    fn start(shared: Arc<Shared>) -> Result<Self, String> {
        let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| format!("could not bind the MCP server on 127.0.0.1: {e}"))?;
        let addr = server.server_addr().to_ip().ok_or_else(|| "the MCP server bound no IP address".to_string())?;
        let server = Arc::new(server);
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let server = server.clone();
            let stop = stop.clone();
            std::thread::Builder::new()
                .name(format!("redrob-app-bridge-mcp-{}", shared.name))
                .spawn(move || {
                    loop {
                        let request = match server.recv() {
                            Ok(r) => r,
                            // `unblock()` makes `recv` fail; a stopped server has nothing else to do.
                            Err(_) if stop.load(Ordering::SeqCst) => return,
                            Err(e) => {
                                log::debug!("app bridge MCP server could not accept a request: {e}");
                                continue;
                            }
                        };
                        if stop.load(Ordering::SeqCst) {
                            let _ = request.respond(tiny_http::Response::empty(503));
                            return;
                        }
                        let shared = shared.clone();
                        // One thread per request: a slow tool call must not hold up the daemon's ping.
                        let spawned = std::thread::Builder::new().name("redrob-app-bridge-request".into()).spawn(move || handle(request, &shared));
                        if let Err(e) = spawned {
                            log::warn!("app bridge could not spawn a request thread: {e}");
                        }
                    }
                })
                .map_err(|e| format!("could not start the MCP server thread: {e}"))?
        };
        Ok(Self { server, addr, stop, thread: Some(thread) })
    }

    fn shutdown(&mut self) {
        if self.stop.swap(true, Ordering::SeqCst) {
            return;
        }
        self.server.unblock();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for McpServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// A live bridge: the MCP server is up and the daemon knows about it. Keep it for as long as the
/// app wants its tools reachable; [`AppBridge::stop`] or dropping it unregisters first (the daemon
/// closes its MCP client) and then stops the server.
pub struct AppBridge {
    registration: Option<redrob_engine_client::AppBridge>,
    server: McpServer,
    mcp_url: String,
}

impl AppBridge {
    /// Find the daemon (or start one, as `name`), serve `tools` on a loopback port and register.
    pub fn start(config: AppBridgeConfig) -> Result<Self, String> {
        let record = redrob_engine_client::connect_or_start_as(&config.name, config.idle_exit_minutes)?;
        Self::start_with(&record, config)
    }

    /// [`AppBridge::start`] against a daemon the app already found (its `Record`).
    pub fn start_with(record: &Record, config: AppBridgeConfig) -> Result<Self, String> {
        if config.name.trim().is_empty() {
            return Err("the app bridge needs a name".to_string());
        }
        let tool_names: Vec<String> = config.tools.iter().map(|t| t.name.clone()).collect();
        let shared = Arc::new(Shared {
            name: config.name.clone(),
            version: config.version.clone().unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()),
            tools: config.tools,
        });
        // The server comes up first so the registration names a URL that already answers; if the
        // registration fails the server is dropped (stopped) with it.
        let server = McpServer::start(shared)?;
        let mcp_url = format!("http://127.0.0.1:{}/mcp", server.addr.port());
        let input = AppRegisterInput { version: config.version, tools: Some(tool_names), ..AppRegisterInput::new(config.name, mcp_url.clone()) };
        let registration = redrob_engine_client::bridge_app(record, input)?;
        Ok(Self { registration: Some(registration), server, mcp_url })
    }

    /// The port the MCP server listens on (always `127.0.0.1`).
    pub fn port(&self) -> u16 {
        self.server.addr.port()
    }

    /// The URL the daemon was given.
    pub fn mcp_url(&self) -> &str {
        &self.mcp_url
    }

    /// The daemon's registration id; changes when the bridge had to register again.
    pub fn id(&self) -> String {
        self.registration.as_ref().map(|r| r.id()).unwrap_or_default()
    }

    /// Unregister from the daemon and stop the server. Dropping the bridge does the same.
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        if let Some(registration) = self.registration.take() {
            registration.stop();
        }
        self.server.shutdown();
    }
}

impl Drop for AppBridge {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// ---------------------------------------------------------------------------------------------
// The transport: one POST, one JSON body, one JSON reply.
// ---------------------------------------------------------------------------------------------

/// Requests larger than this are refused; a tool call carries arguments, not documents.
const MAX_BODY: usize = 4 * 1024 * 1024;

fn json_header() -> tiny_http::Header {
    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).expect("a static header")
}

fn respond(request: tiny_http::Request, status: u16, body: Option<Value>) {
    let response = match body {
        Some(value) => tiny_http::Response::from_string(value.to_string()).with_status_code(status).with_header(json_header()),
        None => tiny_http::Response::from_string(String::new()).with_status_code(status),
    };
    if let Err(e) = request.respond(response) {
        log::debug!("app bridge could not answer a request: {e}");
    }
}

fn handle(mut request: tiny_http::Request, shared: &Shared) {
    match request.method() {
        tiny_http::Method::Post => {}
        tiny_http::Method::Get | tiny_http::Method::Delete => {
            // No server-to-client stream and no sessions: both are optional in the transport.
            return respond(request, 405, None);
        }
        _ => return respond(request, 405, None),
    }
    if request.body_length().is_some_and(|n| n > MAX_BODY) {
        return respond(request, 413, Some(rpc_error(Value::Null, -32600, "request body too large")));
    }
    let mut body = String::new();
    if let Err(e) = request.as_reader().take(MAX_BODY as u64 + 1).read_to_string(&mut body) {
        return respond(request, 400, Some(rpc_error(Value::Null, -32700, &format!("could not read the request body: {e}"))));
    }
    if body.len() > MAX_BODY {
        return respond(request, 413, Some(rpc_error(Value::Null, -32600, "request body too large")));
    }
    let parsed: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => return respond(request, 400, Some(rpc_error(Value::Null, -32700, &format!("parse error: {e}")))),
    };
    // A batch is a JSON array; each request in it gets its reply in the array answered.
    let (messages, batch) = match parsed {
        Value::Array(items) => (items, true),
        single => (vec![single], false),
    };
    let mut replies = Vec::new();
    for message in messages {
        if let Some(reply) = dispatch(message, shared) {
            replies.push(reply);
        }
    }
    match (batch, replies.len()) {
        // Only notifications and client responses: accepted, nothing to say back.
        (_, 0) => respond(request, 202, None),
        (false, _) => respond(request, 200, Some(replies.remove(0))),
        (true, _) => respond(request, 200, Some(Value::Array(replies))),
    }
}

#[derive(Deserialize)]
struct Message {
    #[serde(default)]
    jsonrpc: Option<String>,
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    params: Option<Value>,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<Value>,
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// One JSON-RPC message in; the reply out, or `None` when the message wants none (a notification,
/// or a response to a request this server never sends).
fn dispatch(message: Value, shared: &Shared) -> Option<Value> {
    let message: Message = match serde_json::from_value(message) {
        Ok(m) => m,
        Err(e) => return Some(rpc_error(Value::Null, -32600, &format!("invalid request: {e}"))),
    };
    if message.jsonrpc.as_deref() != Some("2.0") {
        return Some(rpc_error(message.id.unwrap_or(Value::Null), -32600, "invalid request: jsonrpc must be \"2.0\""));
    }
    let Some(method) = message.method else {
        // A response from the client (result or error) to a request we never made: ignore it.
        if message.result.is_some() || message.error.is_some() {
            return None;
        }
        return Some(rpc_error(message.id.unwrap_or(Value::Null), -32600, "invalid request: no method"));
    };
    let Some(id) = message.id else {
        // A notification. `notifications/initialized` and `notifications/cancelled` both land here.
        log::trace!("app bridge notification {method}");
        return None;
    };
    let params = message.params.unwrap_or(Value::Null);
    let result = match method.as_str() {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": shared.name, "version": shared.version },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": shared.tools.iter().map(Tool::descriptor).collect::<Vec<_>>() })),
        "tools/call" => call_tool(params, shared),
        _ => Err((-32601, format!("method not found: {method}"))),
    };
    Some(match result {
        Ok(value) => rpc_result(id, value),
        Err((code, text)) => rpc_error(id, code, &text),
    })
}

fn call_tool(params: Value, shared: &Shared) -> Result<Value, (i64, String)> {
    let name = params.get("name").and_then(Value::as_str).ok_or_else(|| (-32602, "tools/call needs params.name".to_string()))?;
    let tool = shared.tools.iter().find(|t| t.name == name).ok_or_else(|| (-32602, format!("unknown tool: {name}")))?;
    let arguments = match params.get("arguments") {
        None | Some(Value::Null) => json!({}),
        Some(other) => other.clone(),
    };
    let handler = tool.handler.clone();
    // A handler that panics takes down its request thread, not the app: the agent reads the
    // panic as a failed call and can try something else.
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(arguments)));
    let (text, is_error) = match outcome {
        Ok(Ok(text)) => (text, false),
        Ok(Err(text)) => (text, true),
        Err(panic) => {
            let text = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "the tool panicked".to_string());
            log::warn!("app bridge tool {name} panicked: {text}");
            (format!("tool {name} panicked: {text}"), true)
        }
    };
    Ok(json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }))
}
