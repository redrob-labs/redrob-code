# The app bridge

A running Redrob desktop app (Browser, Office, Canvas, Shape, ...) lets the agent drive
it by serving its own MCP tool server on loopback and registering that server with the
shared daemon. The daemon connects it as an MCP server for every session, so a prompt in
any Redrob surface can call the app's tools while the app is up, and forgets it the
moment the app goes away. Companion to [LOCAL-ENGINE-API.md](LOCAL-ENGINE-API.md),
which covers the other direction (the app calling the engine).

## What the engine does with a registration

- Connects `mcp_url` as MCP server **`app:<name>`** on every live instance, and on every
  instance that starts later while the registration stands. Its tools show up to the
  agent under the usual MCP naming (`app:<name>` as the server, the app's own tool names
  below it). `tool_list_changed` notifications from the app are honoured.
- Keeps the registration **in memory only**. The user's `redrob.json` is never written;
  a restarted daemon starts with no bridged apps, and the app registers again (the SDK
  helpers do this on a 404).
- Holds a **client attachment** (`/api/clients`) for the app, so the daemon's idle-exit
  clock does not run while an app is bridged. Heartbeats to `/v1/apps` are status
  traffic, not activity: the attachment is what keeps the daemon up.
- **Drops** the registration when the app `DELETE`s it or when no heartbeat arrives for
  `ttlMs` (90 s): the MCP client is closed, the tools disappear, the attachment is
  detached. The serve loop sweeps every 10 s; `GET /v1/apps` sweeps on read.
- Accepts **loopback only**: the host of `mcp_url` must be `127.0.0.1`, `localhost` or
  `[::1]`, scheme `http` or `https`. Anything else is a 400 `not_loopback`. The daemon
  would otherwise forward every session's tool calls to whatever host an app named.
- One bridge per name: registering a name that is already bridged replaces the older
  registration (the restarted app wins; the stale one is unregistered first).

Names are normalised to `[a-z0-9._-]`, lower-cased, at most 64 characters.

## Endpoints

All under the daemon's base URL from `~/.redrob/run/server.json`, with the record's
`Authorization: Basic redrob:<secret>` header. Paths are exact.

### `POST /v1/apps/register`

```json
{ "name": "canvas", "mcp_url": "http://127.0.0.1:43127/mcp", "pid": 48211, "version": "0.8.1", "tools": ["select", "move"] }
```

`version` and `tools` are optional; `tools` is informational (the engine lists the real
ones from the server). Answer, 200:

```json
{ "id": "7f3b...-...", "ttlMs": 90000 }
```

400 (`InvalidRequestError`, `kind: "not_loopback"`, `field: "mcp_url"`) when the URL is
not loopback; 400 when `name` is empty or `pid` is not a positive integer.

### `POST /v1/apps/:id/heartbeat`

No body. 200 with the app record (below); **404** (`AppNotFoundError`) when the
registration expired or the daemon restarted -- register again. Send one at least every
`ttlMs / 2`; the helpers send every `ttlMs / 3`.

### `DELETE /v1/apps/:id`

204. Idempotent: an id that is already gone is still 204.

### `GET /v1/apps`

```json
{
  "apps": [
    {
      "id": "7f3b...",
      "name": "canvas",
      "mcpUrl": "http://127.0.0.1:43127/mcp",
      "pid": 48211,
      "version": "0.8.1",
      "tools": ["select", "move"],
      "registeredAt": 1760620000000,
      "lastSeen": 1760620030000
    }
  ],
  "ttlMs": 90000
}
```

## From JavaScript (`@redrob-labs/sdk/daemon`)

```ts
import { connectOrStart, bridgeApp, apps } from "@redrob-labs/sdk/daemon"

// 1. Serve the app's tools over MCP on a loopback port (any MCP server library works).
const mcpUrl = await startMyMcpServer({ host: "127.0.0.1" }) // e.g. http://127.0.0.1:43127/mcp

// 2. Find (or start) the shared daemon and bridge.
const connection = await connectOrStart({ idleExitMinutes: 10 })
const bridge = await bridgeApp(connection, {
  name: "canvas",
  mcpUrl,
  version: app.getVersion(),
  tools: ["select", "move", "export_png"],
})
// bridge.id -- the registration; heartbeats run on their own, re-registering after a daemon restart.

// 3. On quit.
app.on("before-quit", () => void bridge.stop())

// Who else is bridged (what `redrob apps list` prints):
const { apps: bridged } = await apps.list(connection)
```

`apps.register / apps.heartbeat / apps.unregister / apps.list` are the four calls one
at a time; `bridgeApp` is the loop built on them.

## From Rust (`redrob-engine-client`)

```rust
use redrob_engine_client::{connect_or_start_as, bridge_app, apps, AppRegisterInput};

// 1. Serve the app's tools over MCP on loopback (rmcp or any MCP server crate).
let mcp_url = my_mcp_server.start_loopback()?; // "http://127.0.0.1:43127/mcp"

// 2. Find or start the daemon and bridge; the heartbeat runs on a background thread.
let record = connect_or_start_as("shape", 10)?;
let bridge = bridge_app(
    &record,
    AppRegisterInput {
        version: Some(env!("CARGO_PKG_VERSION").into()),
        tools: Some(vec!["select".into(), "extrude".into()]),
        ..AppRegisterInput::new("shape", mcp_url)
    },
)?;
log::info!("bridged as {}", bridge.id());

// Who else is bridged:
for app in apps(&record)?.apps { log::info!("{} pid {} {}", app.name, app.pid, app.mcp_url); }

// 3. On quit: unregisters and joins the heartbeat thread. Dropping the bridge does the same.
bridge.stop();
```

`register_app / heartbeat_app / unregister_app / apps` are the four calls; `bridge_app`
is the loop. `heartbeat_app` answers `Ok(None)` on a 404 so the caller knows to register
again.

## Using `redrob-app-bridge` (Rust)

When the app has no MCP server of its own, [`crates/redrob-app-bridge`](../crates/redrob-app-bridge)
does both steps above in one call: it serves the given tools over streamable HTTP on
`127.0.0.1` at a free port from a std thread (no async runtime, so an egui app calls it
from its setup code) and registers through `bridge_app`, heartbeats included. Dropping the
handle unregisters and stops the server.

```rust
use redrob_app_bridge::{AppBridge, AppBridgeConfig, Tool};
use serde_json::json;

let select = Tool::new(
    "select",
    "Select the layer with the given name.",
    json!({ "type": "object", "properties": { "layer": { "type": "string" } }, "required": ["layer"] }),
    move |args| {
        let layer = args["layer"].as_str().ok_or("layer is required")?;
        Ok(format!("selected {layer}")) // Err(text) reaches the agent as isError: true
    },
);
let bridge = AppBridge::start(AppBridgeConfig {
    version: Some(env!("CARGO_PKG_VERSION").into()),
    ..AppBridgeConfig::new("shape", vec![select])
})?;
log::info!("bridged as {} at {}", bridge.id(), bridge.mcp_url());
// On quit: bridge.stop(), or just drop it.
```

The server answers `initialize` (protocol `2025-03-26`), `ping`, `tools/list` and
`tools/call`; notifications get a `202`. `AppBridge::start_with(&record, config)` takes a
daemon the app already connected to.

## From the command line

```
redrob apps list            # NAME  PID  MCP URL  TOOLS  AGE  ID
redrob apps list --json
redrob apps unregister <id> # the engine disconnects that app's MCP server
```

## Writing the app's MCP server

- Bind to `127.0.0.1` (or `::1`) on an ephemeral port; never `0.0.0.0`.
- Streamable HTTP is tried first, then SSE, with a 30 s connect timeout.
- Tool names are the app's own; the engine prefixes them with the server name, so keep
  them short and verb-first (`select`, `move_layer`, `export_png`).
- Send `notifications/tools/list_changed` when the set of tools changes (a document
  opened, a mode switched); the engine re-lists.
- The server speaks only to the daemon on the same machine, which authenticates to the
  app by nothing more than being local. Do not expose destructive operations the user
  did not opt into; the engine's own permission prompts cover tool calls as for any MCP
  server.
