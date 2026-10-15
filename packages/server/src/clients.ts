/**
 * Who is attached to this engine: the apps that called `POST /api/clients`.
 *
 * The shared daemon (`redrob serve --register`) reads this to decide when nobody needs it any
 * more. An app that crashes never detaches, so an attachment also expires when it stops sending
 * heartbeats; a live app sends one every half TTL. Plain module state rather than an Effect
 * service: the serve command polls it from outside the request context.
 */
import { randomUUID } from "node:crypto"
import { Effect } from "effect"

export type Client = {
  readonly id: string
  readonly app: string
  readonly pid?: number
  readonly attachedAt: number
  readonly lastSeen: number
}

/** Heartbeats are expected at least this often; an attachment older than this is dropped. */
export const TTL_MS = 90_000

const clients = new Map<string, Client>()
/** When the last client left, or when the engine started; undefined while someone is attached. */
let idleSince: number | undefined = Date.now()

export function attach(input: { app: string; pid?: number }, now = Date.now()): Client {
  const client: Client = {
    id: randomUUID(),
    app: input.app.trim().slice(0, 64) || "unknown",
    ...(input.pid !== undefined ? { pid: input.pid } : {}),
    attachedAt: now,
    lastSeen: now,
  }
  clients.set(client.id, client)
  idleSince = undefined
  return client
}

export function heartbeat(id: string, now = Date.now()): Client | undefined {
  const client = clients.get(id)
  if (!client) return undefined
  const next = { ...client, lastSeen: now }
  clients.set(id, next)
  return next
}

export function detach(id: string, now = Date.now()): boolean {
  const removed = clients.delete(id)
  if (removed && clients.size === 0) idleSince = now
  return removed
}

/** Drop attachments whose heartbeats stopped; returns how many were dropped. */
export function sweep(now = Date.now()): number {
  let dropped = 0
  for (const [id, client] of clients) {
    if (now - client.lastSeen > TTL_MS) {
      clients.delete(id)
      dropped += 1
    }
  }
  if (dropped > 0 && clients.size === 0) idleSince = now
  return dropped
}

export function list(): Client[] {
  return [...clients.values()].sort((a, b) => a.attachedAt - b.attachedAt)
}

/**
 * Requests count as activity too. The Rust apps (Shape, Canvas, Query, Recall) call the API
 * without attaching, so with attachments alone the daemon would leave ten minutes after it was
 * started -- possibly under a request still being answered. Status polls (health, the client
 * list) are not activity: the launcher's engine card asks every few seconds.
 */
let lastRequestAt: number | undefined
let inFlight = 0

const STATUS_PATHS = ["/api/health", "/api/clients"]

/** Whether a request to this path keeps the daemon alive. */
export function countsAsActivity(path: string): boolean {
  return !STATUS_PATHS.some(
    (prefix) => path === prefix || path.startsWith(prefix + "/") || path.startsWith(prefix + "?"),
  )
}

export function requestStarted(now = Date.now()): void {
  inFlight += 1
  lastRequestAt = now
}

export function requestEnded(now = Date.now()): void {
  inFlight = Math.max(0, inFlight - 1)
  lastRequestAt = now
}

/** Run an authorized request's effect, counting it as activity unless it is a status poll. */
export function withActivity<A, E, R>(path: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  if (!countsAsActivity(path)) return effect
  return Effect.suspend(() => {
    requestStarted()
    return Effect.ensuring(
      effect,
      Effect.sync(() => requestEnded()),
    )
  })
}

/**
 * How long nobody has needed this engine, in ms: no attachment, no request in flight, and no
 * request since. Undefined while someone is attached or a request is being answered.
 */
export function idleFor(now = Date.now()): number | undefined {
  if (idleSince === undefined || inFlight > 0) return undefined
  const since = lastRequestAt === undefined ? idleSince : Math.max(idleSince, lastRequestAt)
  return now - since
}

/** Test seam. */
export function reset(now = Date.now()): void {
  clients.clear()
  idleSince = now
  lastRequestAt = undefined
  inFlight = 0
}
