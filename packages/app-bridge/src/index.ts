/**
 * The app bridge, in one call: serve the app's tools as an MCP server on loopback, register that
 * server with the shared daemon, keep the registration alive, unregister on stop.
 *
 * docs/APP-BRIDGE.md. The daemon side (find or start, register, heartbeat, re-register after a
 * daemon restart) is `@redrob-labs/sdk/daemon`; this package adds the MCP server in front of it
 * so a desktop app does not have to assemble one from the MCP SDK itself.
 *
 * Streamable HTTP over `node:http`, bound to 127.0.0.1 on a random free port, one MCP session per
 * connecting client (the daemon is normally the only one). Stateful so that the server can push
 * `notifications/tools/list_changed` when the app swaps its tool set with `setTools`.
 */
import { randomUUID } from "node:crypto"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js"
import { parseWithCompat, toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import {
  bridgeApp,
  connectOrStart,
  type DaemonConnection,
  type DaemonOptions,
} from "@redrob-labs/sdk/daemon"

/** A JSON Schema object describing the tool's arguments (`type: "object"`). */
export type JsonSchema = { readonly type: "object"; readonly [key: string]: unknown }

/** What a tool handler may answer: a plain string becomes one text content block. */
export type ToolResult = string | CallToolResult

export type ToolDef = {
  /** The app's own tool name; the engine shows it under `app:<name>`. Short and verb-first. */
  readonly name: string
  readonly description: string
  /**
   * The arguments: a zod object schema (v3 or v4, validated before the handler runs) or a JSON
   * Schema object (passed to the engine as is, not validated here). Omitted: no arguments.
   */
  readonly input?: AnySchema | JsonSchema
  readonly handler: (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>
}

export type StartAppBridgeOptions = {
  /** The app's name; normalised by the engine to `[a-z0-9._-]`, at most 64 characters. */
  readonly name: string
  readonly version?: string
  readonly tools: readonly ToolDef[]
  /** A daemon connection to use. Omitted: `connectOrStart(daemon)` from `@redrob-labs/sdk/daemon`. */
  readonly connect?: DaemonConnection
  /** Options for `connectOrStart` when `connect` is not given. */
  readonly daemon?: DaemonOptions
  /** URL path the MCP server answers on. Default `/mcp`. */
  readonly path?: string
}

export type AppBridgeHandle = {
  /** The loopback port the MCP server listens on. */
  readonly port: number
  /** The MCP URL the daemon was given, `http://127.0.0.1:<port>/mcp`. */
  readonly url: string
  /** The current registration id with the daemon; changes after a daemon restart. */
  readonly id: string
  /** Replace the tool set; every connected client is told `tools/list_changed`. */
  readonly setTools: (tools: readonly ToolDef[]) => void
  /** Unregister from the daemon, close every MCP session, stop listening. Safe to call twice. */
  readonly stop: () => Promise<void>
}

const NO_ARGS: JsonSchema = { type: "object", properties: {} }

function isZodSchema(input: AnySchema | JsonSchema): input is AnySchema {
  return typeof input === "object" && input !== null && ("_def" in input || "_zod" in input || "~standard" in input)
}

function inputSchema(def: ToolDef): JsonSchema {
  if (!def.input) return NO_ARGS
  if (isZodSchema(def.input)) return toJsonSchemaCompat(def.input, { strictUnions: true }) as JsonSchema
  return def.input
}

function toCallResult(result: ToolResult): CallToolResult {
  if (typeof result === "string") return { content: [{ type: "text", text: result }] }
  return result
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] }
}

type Session = { readonly server: McpServer; readonly transport: StreamableHTTPServerTransport }

/**
 * Serve `tools` over MCP on 127.0.0.1 and bridge the server into the shared daemon. Resolves once
 * the daemon has accepted the registration; rejects when the daemon cannot be reached or refuses
 * the app (the HTTP server is closed again in that case).
 */
export async function startAppBridge(options: StartAppBridgeOptions): Promise<AppBridgeHandle> {
  const path = options.path ?? "/mcp"
  let tools = new Map(options.tools.map((t) => [t.name, t] as const))
  const sessions = new Map<string, Session>()

  const newServer = (): McpServer => {
    const server = new McpServer(
      { name: options.name, version: options.version ?? "0.0.0" },
      { capabilities: { tools: { listChanged: true } } },
    )
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [...tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t) })),
    }))
    server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const def = tools.get(request.params.name)
      if (!def) return failure(`Unknown tool: ${request.params.name}`)
      let args: Record<string, unknown> = request.params.arguments ?? {}
      if (def.input && isZodSchema(def.input)) {
        try {
          args = parseWithCompat(def.input, args) as Record<string, unknown>
        } catch (cause) {
          return failure(`Invalid arguments for ${def.name}: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }
      try {
        return toCallResult(await def.handler(args))
      } catch (cause) {
        return failure(cause instanceof Error ? cause.message : String(cause))
      }
    })
    return server
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== path) {
      res.writeHead(404).end()
      return
    }
    try {
      const sessionId = req.headers["mcp-session-id"]
      if (typeof sessionId === "string") {
        const session = sessions.get(sessionId)
        if (!session) {
          res.writeHead(404, { "content-type": "application/json" }).end(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }),
          )
          return
        }
        await session.transport.handleRequest(req, res)
        return
      }
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" }).end()
        return
      }
      // No session yet: this must be `initialize`. The transport answers 400 itself when it is not,
      // in which case `onsessioninitialized` never fires and the pair is dropped below.
      const server = newServer()
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { server, transport })
        },
        onsessionclosed: (id) => {
          sessions.delete(id)
        },
      })
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId)
      }
      await server.connect(transport)
      await transport.handleRequest(req, res)
      if (!transport.sessionId) await server.close().catch(() => undefined)
    } catch (cause) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: cause instanceof Error ? cause.message : String(cause) },
            id: null,
          }),
        )
      }
    }
  })

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once("error", reject)
    httpServer.listen(0, "127.0.0.1", () => resolve((httpServer.address() as AddressInfo).port))
  })
  const mcpUrl = `http://127.0.0.1:${port}${path}`

  const closeAll = async () => {
    const open = [...sessions.values()]
    sessions.clear()
    await Promise.all(open.map((s) => s.server.close().catch(() => undefined)))
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    httpServer.closeAllConnections?.()
  }

  let bridge: Awaited<ReturnType<typeof bridgeApp>>
  try {
    const connection = options.connect ?? (await connectOrStart(options.daemon))
    bridge = await bridgeApp(connection, {
      name: options.name,
      mcpUrl,
      ...(options.version !== undefined ? { version: options.version } : {}),
      tools: [...tools.keys()],
    })
  } catch (cause) {
    await closeAll()
    throw cause
  }

  let stopped = false
  return {
    port,
    url: mcpUrl,
    get id() {
      return bridge.id
    },
    setTools: (next) => {
      tools = new Map(next.map((t) => [t.name, t] as const))
      for (const session of sessions.values()) session.server.sendToolListChanged()
    },
    stop: async () => {
      if (stopped) return
      stopped = true
      await bridge.stop()
      await closeAll()
    },
  }
}
