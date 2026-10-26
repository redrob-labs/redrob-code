/**
 * App tool danger classification for the mobile permission profile (docs/desk-relay.md,
 * "Mobile profile").
 *
 * Every bridged app from `GET /v1/apps` becomes server `app:<name>` with its tools, their MCP
 * annotations and a risk class. `/v1/apps` only carries tool NAMES, so the annotations are read
 * from the app's own loopback MCP server (`initialize` + `tools/list`, streamable HTTP, the same
 * server the engine connects to). An app whose server cannot be asked keeps its names with no
 * annotations, which the rule classes as dangerous. The dangerous set feeds
 * `MobileProfile.setDangerousActions`, so a dangerous app tool asks on a phone session.
 */
import { MobileProfile } from "@redrob-code/core/permission/mobile"
import type { BridgedApp, DaemonApi } from "./daemon"

export type Risk = "read" | "write" | "dangerous"

export type Annotations = {
  readonly title?: string
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
}

export type ToolInfo = {
  readonly name: string
  readonly description?: string
  readonly risk: Risk
  readonly annotations?: Annotations
}

export type ToolServer = { readonly name: string; readonly tools: readonly ToolInfo[] }

const DANGEROUS_NAME = MobileProfile.DANGEROUS_NAME
const SEND_VERB = /(send|share|post|publish|email|mail|message|upload)/i

/**
 * The design's risk rule. Dangerous wins over everything: `destructiveHint: true`, an open-world
 * tool with a send/share verb, a name with a dangerous verb, or no annotations at all.
 */
export function classify(name: string, annotations: Annotations | undefined): Risk {
  if (DANGEROUS_NAME.test(name)) return "dangerous"
  if (!annotations || Object.keys(annotations).length === 0) return "dangerous"
  if (annotations.destructiveHint === true) return "dangerous"
  if (annotations.openWorldHint === true && SEND_VERB.test(name)) return "dangerous"
  if (annotations.readOnlyHint === true) return "read"
  // MCP's default for destructiveHint is true; only an explicit false makes a writer safe.
  if (annotations.destructiveHint === false) return "write"
  return "dangerous"
}

/** The engine's MCP tool id for a server + tool (redrob `mcp/catalog.ts` `toolName`). */
export function engineToolName(server: string, tool: string): string {
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")
  return `${sanitize(server)}_${sanitize(tool)}`
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1"
  } catch {
    return false
  }
}

type RpcResult = { result?: Record<string, unknown>; error?: { message?: string } }

/** One JSON-RPC call over streamable HTTP; reads a JSON or an SSE answer. */
async function rpc(
  url: string,
  body: Record<string, unknown>,
  session: { id?: string },
  fetchImpl: typeof fetch,
): Promise<RpcResult | undefined> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(session.id ? { "Mcp-Session-Id": session.id } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    signal: AbortSignal.timeout(5_000),
  })
  const sessionId = response.headers.get("mcp-session-id")
  if (sessionId) session.id = sessionId
  if (!response.ok) throw new Error(`${response.status}`)
  if (body.id === undefined) return undefined
  const text = await response.text()
  const type = response.headers.get("content-type") ?? ""
  if (!type.includes("text/event-stream")) return text ? (JSON.parse(text) as RpcResult) : undefined
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    try {
      const message = JSON.parse(line.slice(5).trim()) as RpcResult & { id?: unknown }
      if (message.id === body.id) return message
    } catch {
      // keep looking
    }
  }
  return undefined
}

/** `tools/list` of one app's MCP server, all pages. Throws when the server cannot be asked. */
export async function listAppTools(mcpUrl: string, appVersion: string, fetchImpl: typeof fetch = fetch): Promise<ToolInfo[]> {
  if (!isLoopback(mcpUrl)) throw new Error("not loopback")
  const session: { id?: string } = {}
  await rpc(
    mcpUrl,
    {
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "redrob-desk", version: appVersion },
      },
    },
    session,
    fetchImpl,
  )
  await rpc(mcpUrl, { method: "notifications/initialized" }, session, fetchImpl).catch(() => undefined)
  const out: ToolInfo[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const answer = await rpc(
      mcpUrl,
      { id: 2 + page, method: "tools/list", params: cursor ? { cursor } : {} },
      session,
      fetchImpl,
    )
    if (!answer?.result) throw new Error(answer?.error?.message ?? "no tools/list result")
    const tools = Array.isArray(answer.result.tools) ? (answer.result.tools as Record<string, unknown>[]) : []
    for (const tool of tools) {
      const name = typeof tool.name === "string" ? tool.name : undefined
      if (!name) continue
      const annotations =
        typeof tool.annotations === "object" && tool.annotations !== null ? (tool.annotations as Annotations) : undefined
      out.push({
        name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        risk: classify(name, annotations),
        ...(annotations ? { annotations } : {}),
      })
    }
    cursor = typeof answer.result.nextCursor === "string" ? answer.result.nextCursor : undefined
    if (!cursor) break
  }
  return out
}

/** How long an app's annotations are trusted before `tools/list` is asked again. */
const RELIST_MS = 60_000

type Cached = { readonly key: string; readonly at: number; readonly tools: readonly ToolInfo[] }

export type ToolsChange = { readonly server: string; readonly tools: readonly ToolInfo[] }

/**
 * The current tool list, its revision, and what changed since the last `refresh`. Also keeps the
 * core mobile permission profile's dangerous set in step, so a dangerous app tool asks on a phone
 * session.
 */
export class ToolCatalog {
  private servers = new Map<string, ToolServer>()
  private readonly cache = new Map<string, Cached>()
  private readonly names = new Map<string, { server: string; tool: string }>()
  rev = 0

  constructor(
    private readonly daemon: DaemonApi,
    private readonly appVersion: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  snapshot(): { kind: "snapshot"; rev: number; servers: ToolServer[] } {
    return { kind: "snapshot", rev: this.rev, servers: [...this.servers.values()] }
  }

  /** Split an engine tool id (`app_canvas_select`) back into server + tool, when it is an app tool we know. */
  lookup(engineName: string): { server: string; tool: string } | undefined {
    return this.names.get(engineName)
  }

  riskOf(engineName: string): Risk | undefined {
    const named = this.names.get(engineName)
    if (!named) return undefined
    return this.servers.get(named.server)?.tools.find((tool) => tool.name === named.tool)?.risk
  }

  /** Re-read `/v1/apps`; returns one change per server that appeared, changed or went away. */
  async refresh(now = Date.now()): Promise<ToolsChange[]> {
    const { apps } = await this.daemon.apps()
    const next = new Map<string, ToolServer>()
    for (const app of apps) next.set(`app:${app.name}`, { name: `app:${app.name}`, tools: await this.toolsOf(app, now) })
    for (const id of [...this.cache.keys()]) if (!apps.some((app) => app.id === id)) this.cache.delete(id)

    const changes: ToolsChange[] = []
    for (const [name, server] of next) {
      const before = this.servers.get(name)
      if (!before || JSON.stringify(before.tools) !== JSON.stringify(server.tools)) changes.push({ server: name, tools: server.tools })
    }
    for (const name of this.servers.keys()) if (!next.has(name)) changes.push({ server: name, tools: [] })
    this.servers = next
    this.rev += changes.length

    this.names.clear()
    const dangerous: string[] = []
    for (const server of next.values()) {
      for (const tool of server.tools) {
        const engine = engineToolName(server.name, tool.name)
        this.names.set(engine, { server: server.name, tool: tool.name })
        if (tool.risk === "dangerous") dangerous.push(engine, `${server.name}.${tool.name}`)
      }
    }
    MobileProfile.setDangerousActions(dangerous)
    return changes
  }

  private async toolsOf(app: BridgedApp, now: number): Promise<readonly ToolInfo[]> {
    const key = `${app.registeredAt}:${(app.tools ?? []).join(",")}`
    const cached = this.cache.get(app.id)
    if (cached && cached.key === key && now - cached.at < RELIST_MS) return cached.tools
    let tools: readonly ToolInfo[]
    try {
      tools = await listAppTools(app.mcpUrl, this.appVersion, this.fetchImpl)
    } catch {
      // Could not ask the app: names only, no annotations, so every one of them is dangerous.
      tools = (app.tools ?? []).map((name) => ({ name, risk: classify(name, undefined) }))
    }
    this.cache.set(app.id, { key, at: now, tools })
    return tools
  }
}
