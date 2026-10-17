/**
 * The app bridge: Redrob desktop apps that registered their own loopback MCP tool server with
 * this engine (`POST /v1/apps/register`), so the agent can drive the app. docs/APP-BRIDGE.md.
 *
 * Plain module state like `clients.ts`, and for the same reason: the serve loop sweeps it from
 * outside any request. The MCP service (which lives upstream of this package) subscribes to the
 * registry to connect `app:<name>` for every live instance and to drop it again; nothing here
 * touches the user's config file. An app that crashes never unregisters, so an entry also expires
 * when its heartbeats stop; a live app sends one every third of the TTL.
 *
 * Every bridged app also holds a `clients.ts` attachment, so the daemon's idle-exit clock does not
 * run while an app is bridged.
 */
import { randomUUID } from "node:crypto"
import * as Clients from "./clients"

export type App = {
  readonly id: string
  readonly name: string
  readonly mcpUrl: string
  readonly pid: number
  readonly version?: string
  /** Tool names the app announced; informational, the MCP client lists the real ones. */
  readonly tools?: readonly string[]
  readonly registeredAt: number
  readonly lastSeen: number
}

/** Heartbeats are expected at least this often; a registration older than this is dropped. */
export const TTL_MS = Clients.TTL_MS

/** The MCP server name a bridged app is connected under. */
export function mcpName(appName: string): string {
  return `app:${appName}`
}

export type Change = { readonly kind: "registered"; readonly app: App } | { readonly kind: "unregistered"; readonly app: App }
export type Listener = (change: Change) => void

const apps = new Map<string, App>()
/** The `clients.ts` attachment each registration holds. */
const attachments = new Map<string, string>()
const listeners = new Set<Listener>()

/** Hear every registration and removal. Returns the unsubscribe. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function emit(change: Change): void {
  for (const listener of listeners) {
    try {
      listener(change)
    } catch {
      /* a listener's failure is its own */
    }
  }
}

/**
 * Only an MCP server on this machine may be bridged: the daemon would otherwise hand every
 * session's tool calls to whatever host an app named.
 */
export function isLoopback(mcpUrl: string): boolean {
  let url: URL
  try {
    url = new URL(mcpUrl)
  } catch {
    return false
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  const host = url.hostname.toLowerCase()
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1"
}

/** A name that is safe as an MCP server key and as a tool-name prefix. */
export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

export function register(
  input: { name: string; mcpUrl: string; pid: number; version?: string; tools?: readonly string[] },
  now = Date.now(),
): App {
  const name = normalizeName(input.name) || "app"
  // One bridge per app name: a restarted app replaces the entry it left behind.
  for (const existing of apps.values()) {
    if (existing.name === name) unregister(existing.id, now)
  }
  const app: App = {
    id: randomUUID(),
    name,
    mcpUrl: input.mcpUrl,
    pid: input.pid,
    ...(input.version !== undefined ? { version: input.version } : {}),
    ...(input.tools !== undefined ? { tools: [...input.tools] } : {}),
    registeredAt: now,
    lastSeen: now,
  }
  apps.set(app.id, app)
  attachments.set(app.id, Clients.attach({ app: mcpName(name), pid: input.pid }, now).id)
  emit({ kind: "registered", app })
  return app
}

export function heartbeat(id: string, now = Date.now()): App | undefined {
  const app = apps.get(id)
  if (!app) return undefined
  const next = { ...app, lastSeen: now }
  apps.set(id, next)
  const attachment = attachments.get(id)
  if (attachment && !Clients.heartbeat(attachment, now)) {
    attachments.set(id, Clients.attach({ app: mcpName(app.name), pid: app.pid }, now).id)
  }
  return next
}

export function unregister(id: string, now = Date.now()): boolean {
  const app = apps.get(id)
  if (!app) return false
  apps.delete(id)
  const attachment = attachments.get(id)
  attachments.delete(id)
  if (attachment) Clients.detach(attachment, now)
  emit({ kind: "unregistered", app })
  return true
}

/** Drop registrations whose heartbeats stopped; returns how many were dropped. */
export function sweep(now = Date.now()): number {
  let dropped = 0
  for (const [id, app] of apps) {
    if (now - app.lastSeen > TTL_MS) {
      unregister(id, now)
      dropped += 1
    }
  }
  return dropped
}

export function get(id: string): App | undefined {
  return apps.get(id)
}

export function list(): App[] {
  return [...apps.values()].sort((a, b) => a.registeredAt - b.registeredAt)
}

/** Test seam. */
export function reset(): void {
  for (const id of [...apps.keys()]) unregister(id)
  listeners.clear()
}
