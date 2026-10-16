# @redrob-code/app-bridge

One call that hands the Redrob daemon agent an app's tools. It serves the tools as an MCP
server (streamable HTTP, `127.0.0.1`, random free port), finds or starts the shared daemon
through `@redrob-labs/sdk/daemon`, registers the server with `POST /v1/apps/register`, keeps the
registration alive (re-registering after a daemon restart) and unregisters on `stop()`.
Protocol details: `docs/APP-BRIDGE.md`.

```ts
import { startAppBridge } from "@redrob-code/app-bridge"
import { z } from "zod"

const bridge = await startAppBridge({
  name: "canvas",
  version: app.getVersion(),
  tools: [
    {
      name: "select",
      description: "Select the layer with the given id.",
      input: z.object({ id: z.string() }),
      handler: ({ id }) => (canvas.select(String(id)) ? `selected ${id}` : `no layer ${id}`),
    },
    {
      name: "export_png",
      description: "Export the current document as PNG and answer the file path.",
      input: { type: "object", properties: { scale: { type: "number" } } },
      handler: async ({ scale }) => await canvas.exportPng(typeof scale === "number" ? scale : 1),
    },
  ],
})
console.log(`bridged on port ${bridge.port} as ${bridge.id}`)

bridge.setTools([...])                      // when the tool set changes; clients get tools/list_changed
app.on("before-quit", () => void bridge.stop()) // unregister, close sessions, stop listening
```

## API

- `startAppBridge({ name, version?, tools, connect?, daemon?, path? }) -> Promise<AppBridgeHandle>`
  - `tools: ToolDef[]` with `{ name, description, input?, handler(args) }`. `input` is a zod
    object schema (v3 or v4; arguments are validated before `handler` runs) or a JSON Schema
    object (passed to the engine as is). `handler` answers a string (one text block) or an MCP
    `CallToolResult`. A thrown error becomes an `isError` result, not a dropped request.
  - `connect`: an existing `DaemonConnection`; otherwise `connectOrStart(daemon)` is used.
  - `path`: the MCP path, default `/mcp`.
- `AppBridgeHandle`: `port`, `url`, `id` (current registration id), `setTools(tools)`, `stop()`.

The server binds loopback only, which is also the only thing the engine accepts.
