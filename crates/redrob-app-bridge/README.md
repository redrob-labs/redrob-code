# redrob-app-bridge

Expose a Rust Redrob app's tools to the shared Redrob Code daemon in one call. The crate
serves the tools over MCP (streamable HTTP) on `127.0.0.1` at a free port from a plain std
thread -- no async runtime, so an egui app calls it from its setup code -- and registers
that server with the daemon through [`redrob-engine-client`](../engine-client)'s
`bridge_app`, which heartbeats and registers again after a daemon restart. Stopping or
dropping the bridge unregisters and stops the server. The contract is the engine's
[`docs/APP-BRIDGE.md`](../../docs/APP-BRIDGE.md).

```toml
[dependencies]
redrob-app-bridge = { git = "https://github.com/redrob-labs/redrob-code", tag = "v0.6.3" }
```

## Example

```rust
use redrob_app_bridge::{AppBridge, AppBridgeConfig, Tool};
use serde_json::json;

fn bridge(doc: std::sync::Arc<std::sync::Mutex<Document>>) -> Result<AppBridge, String> {
    let select = {
        let doc = doc.clone();
        Tool::new(
            "select",
            "Select the layer with the given name.",
            json!({ "type": "object", "properties": { "layer": { "type": "string" } }, "required": ["layer"] }),
            move |args| {
                let layer = args["layer"].as_str().ok_or("layer is required")?;
                doc.lock().map_err(|e| e.to_string())?.select(layer).map_err(|e| e.to_string())?;
                Ok(format!("selected {layer}"))
            },
        )
    };
    let export_png = Tool::new("export_png", "Export the document as PNG; answers the path.", json!({ "type": "object" }), move |_| {
        doc.lock().map_err(|e| e.to_string())?.export_png().map_err(|e| e.to_string())
    });
    AppBridge::start(AppBridgeConfig { version: Some(env!("CARGO_PKG_VERSION").into()), ..AppBridgeConfig::new("canvas", vec![select, export_png]) })
}
// Keep the returned `AppBridge` in the app's state; `bridge.stop()` (or dropping it) on quit.
```

While the bridge stands, any Redrob surface's agent sees the tools as MCP server
`app:canvas` with `select` and `export_png` under it; `redrob apps list` shows the
registration. A handler's `Err(text)` reaches the agent as a failed tool result
(`isError: true`), a panic in a handler is caught and reported the same way.

## What the server speaks

`POST` with a JSON-RPC 2.0 body (one message or a batch) at any path; every reply is an
`application/json` body. `initialize` (protocol `2025-03-26`, `capabilities.tools`,
`serverInfo`), `ping`, `tools/list`, `tools/call` (`{ content: [{ type: "text", text }], isError }`).
Notifications (`notifications/initialized`, ...) are answered `202` with no body. `GET` and
`DELETE` are `405`: there is no server-to-client stream and no session. Each request runs on
its own thread, so a slow tool call never holds up the daemon's `ping`.

## API

- `AppBridge::start(AppBridgeConfig) -> Result<AppBridge, String>` -- find or start the
  daemon (as the app's name), serve, register.
- `AppBridge::start_with(&Record, AppBridgeConfig)` -- the same against a daemon the app
  already connected to.
- `AppBridge::{port, mcp_url, id, stop}`; `Drop` does what `stop` does.
- `AppBridgeConfig { name, version, tools, idle_exit_minutes }`, `AppBridgeConfig::new(name, tools)`.
- `Tool { name, description, input_schema, handler }`, `Tool::new(name, description, schema, handler)`;
  `handler: Arc<dyn Fn(Value) -> Result<String, String> + Send + Sync>`.
