/**
 * Who is attached to this engine: the apps that called `POST /api/clients`.
 *
 * The shared daemon (`redrob serve --register`) reads this to decide when nobody needs it any
 * more. An app that crashes never detaches, so an attachment also expires when it stops sending
 * heartbeats; a live app sends one every half TTL. Plain module state rather than an Effect
 * service: the serve command polls it from outside the request context.
 */
import { randomUUID } from "node:crypto"

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

/** How long nobody has been attached, in ms; undefined while someone is. */
export function idleFor(now = Date.now()): number | undefined {
  return idleSince === undefined ? undefined : now - idleSince
}

/** Test seam. */
export function reset(now = Date.now()): void {
  clients.clear()
  idleSince = now
}
