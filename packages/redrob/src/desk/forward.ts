/**
 * The desk forwarder (redrob-mobile `docs/desk-relay.md`, section 4): what a paired device (the
 * phone app or a web browser) may ask of this daemon, and the live events it gets back.
 *
 * `ROUTES` is the only security boundary. A `req` outside it is answered 403 without touching the
 * daemon. A session created or prompted from any device, phone or web alike, is marked with
 * `MobileProfile.mark`, so saved approvals do not apply to it and dangerous actions always ask.
 */
import { MobileProfile } from "@redrob-code/core/permission/mobile"
import type { BusEvent, DaemonApi } from "./daemon"
import { MAX_RELAY_FRAME_BYTES } from "./frames"

/** Room for the frame header and the seal on top of the JSON. */
const MAX_BODY_BYTES = MAX_RELAY_FRAME_BYTES - 64 * 1024

type Method = "GET" | "POST"

type Route = {
  readonly method: Method
  readonly path: RegExp
  /** Whether a query string is passed through. */
  readonly query?: boolean
  /** Extra body rule; false answers 403. */
  readonly body?: (body: unknown) => boolean
  /** Mark the session the call names (capture 1) or creates (`created`). */
  readonly mark?: "named" | "created"
  /** A phone prompt: watch the turn so its end can be pushed. */
  readonly prompt?: boolean
}

/** One path segment of an id. Nothing that can climb or re-encode a path. */
const ID = "([A-Za-z0-9_-]{1,128})"

/**
 * The allowlist. Keep in step with docs/desk-relay.md, section 4. `history` also passes its query
 * (`after`, `limit`) through: it is a read and pages are how the phone loads a long session.
 */
export const ROUTES: readonly Route[] = [
  { method: "GET", path: /^\/api\/session$/, query: true },
  { method: "POST", path: /^\/api\/session$/, mark: "created" },
  { method: "GET", path: /^\/api\/session\/active$/ },
  { method: "GET", path: new RegExp(`^/api/session/${ID}$`) },
  { method: "GET", path: new RegExp(`^/api/session/${ID}/history$`), query: true },
  { method: "POST", path: new RegExp(`^/api/session/${ID}/prompt$`), mark: "named", prompt: true },
  { method: "POST", path: new RegExp(`^/api/session/${ID}/interrupt$`) },
  { method: "GET", path: new RegExp(`^/api/session/${ID}/permission$`) },
  {
    method: "POST",
    path: new RegExp(`^/api/session/${ID}/permission/${ID}/reply$`),
    body: (body) => {
      const reply = (body as { reply?: unknown } | undefined)?.reply
      return reply === "once" || reply === "reject"
    },
  },
  { method: "GET", path: /^\/v1\/apps$/ },
]

/** Session list events, forwarded for every session so the phone's list stays current. */
const LIST_EVENTS = new Set(["session.created", "session.updated", "session.deleted"])
const COALESCE_MS = 100

export type Request = { readonly method: Method; readonly path: string; readonly body?: unknown }

/** The route a request matches, and the session id it names; undefined when not allowed. */
export function match(request: Request): { route: Route; sessionID?: string } | undefined {
  if (request.method !== "GET" && request.method !== "POST") return undefined
  if (typeof request.path !== "string" || request.path.length > 2048 || !request.path.startsWith("/")) return undefined
  const mark = request.path.indexOf("?")
  const pathname = mark >= 0 ? request.path.slice(0, mark) : request.path
  if (request.method === "GET" && request.body !== undefined) return undefined
  for (const route of ROUTES) {
    if (route.method !== request.method) continue
    const found = route.path.exec(pathname)
    if (!found) continue
    if (mark >= 0 && !route.query) return undefined
    if (route.body && !route.body(request.body)) return undefined
    return { route, sessionID: found[1] }
  }
  return undefined
}

/** One paired, connected phone, as the relay hands it to the forwarder. */
export type Link = {
  /** Seal and send one `desk.msg` message. */
  send(message: Record<string, unknown>): Promise<void>
  subscriptions: Set<string>
  queue: BusEvent[]
  timer?: ReturnType<typeof setTimeout>
}

export type Notify = (kind: "done" | "approval", sessionId: string) => Promise<void>

export class Forwarder {
  private readonly links = new Set<Link>()
  private readonly waiting = new Set<string>()
  private abort?: AbortController

  constructor(
    private readonly daemon: DaemonApi,
    private readonly notify: Notify,
    private readonly log: (message: string) => void,
  ) {}

  link(send: Link["send"]): Link {
    const link: Link = { send, subscriptions: new Set(), queue: [] }
    this.links.add(link)
    return link
  }

  unlink(link: Link): void {
    if (link.timer) clearTimeout(link.timer)
    this.links.delete(link)
  }

  /** Whether any connected phone is watching this session right now. */
  watched(sessionID: string): boolean {
    for (const link of this.links) if (link.subscriptions.has(sessionID)) return true
    return false
  }

  /** One decrypted `desk.msg` message from a phone. */
  async handle(link: Link, message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null) return
    const value = message as Record<string, unknown>
    if (value.t === "sub") {
      const sessions = Array.isArray(value.sessions) ? value.sessions.filter((id): id is string => typeof id === "string") : []
      link.subscriptions = new Set(sessions.slice(0, 200))
      return
    }
    if (value.t !== "req" || typeof value.id !== "number" || !Number.isInteger(value.id)) return
    const id = value.id
    const request = { method: value.method, path: value.path, body: value.body } as Request
    const allowed = match(request)
    if (!allowed) return link.send({ t: "res", id, status: 403 })

    const { route, sessionID } = allowed
    if (route.mark === "named" && sessionID) MobileProfile.mark(sessionID)
    const result = await this.daemon.raw(request.method, request.path, request.body).catch((error: unknown) => {
      this.log(`forward ${request.method} failed: ${error instanceof Error ? error.message : String(error)}`)
      return { status: 502, body: undefined }
    })
    const ok = result.status >= 200 && result.status < 300
    if (ok && route.mark === "created") {
      const created = (result.body as { data?: { id?: unknown } } | undefined)?.data?.id
      if (typeof created === "string") MobileProfile.mark(created)
    }
    if (ok && route.prompt && sessionID) this.watchTurn(sessionID)
    // A stop may leave no step.ended behind; the phone's stop must still end the turn.
    if (ok && sessionID && request.method === "POST" && request.path.endsWith("/interrupt")) this.turnEnded(sessionID)
    // The relay drops a frame over 8 MB and the phone would wait forever. Say 413 instead;
    // the phone asks for a smaller history page.
    if (result.body !== undefined && Buffer.byteLength(JSON.stringify(result.body)) > MAX_BODY_BYTES) {
      return link.send({ t: "res", id, status: 413 })
    }
    await link.send({ t: "res", id, status: result.status, ...(result.body !== undefined ? { body: result.body } : {}) })
  }

  /**
   * After a phone prompt: when the turn ends, tell subscribed phones with a synthetic
   * `session.idle` event (the bus carries none), and push "done" when no phone is watching.
   *
   * The turn's end is read off the bus: `session.next.step.failed`, or `session.next.step.ended`
   * whose finish is not a tool call (a tool call starts another step). `POST /api/session/:id/wait`
   * is not used: V2 sessions answer it 503 "Session wait is not available yet", so the phone never
   * heard the turn end and showed "working" forever, and stop could not end it either.
   */
  private watchTurn(sessionID: string): void {
    this.waiting.add(sessionID)
  }

  private turnEnded(sessionID: string): void {
    if (!this.waiting.delete(sessionID)) return
    this.onEvent({ type: "session.idle", data: { sessionID } })
    if (!this.watched(sessionID)) void this.notify("done", sessionID).catch(() => undefined)
  }

  /** Follow `GET /api/event` until `stop`, reconnecting with backoff. */
  start(): void {
    if (this.abort) return
    const abort = new AbortController()
    this.abort = abort
    void (async () => {
      let delay = 1_000
      while (!abort.signal.aborted) {
        const started = Date.now()
        await this.daemon.events((event) => this.onEvent(event), abort.signal).catch(() => undefined)
        if (abort.signal.aborted) return
        if (Date.now() - started > 30_000) delay = 1_000
        await new Promise((resolve) => setTimeout(resolve, delay))
        delay = Math.min(delay * 2, 30_000)
      }
    })()
  }

  stop(): void {
    this.abort?.abort()
    this.abort = undefined
    for (const link of [...this.links]) this.unlink(link)
  }

  private onEvent(event: BusEvent): void {
    const sessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : undefined
    const permission = event.type.startsWith("permission.")
    if (event.type === "permission.v2.asked" && sessionID && MobileProfile.isMobile(sessionID) && !this.watched(sessionID)) {
      void this.notify("approval", sessionID).catch(() => undefined)
    }
    for (const link of this.links) {
      const wanted = permission || LIST_EVENTS.has(event.type) || (sessionID !== undefined && link.subscriptions.has(sessionID))
      if (!wanted) continue
      link.queue.push(event)
      if (!link.timer) link.timer = setTimeout(() => this.flush(link), COALESCE_MS)
    }
    if (sessionID && this.waiting.has(sessionID)) {
      const finish = typeof event.data?.finish === "string" ? event.data.finish : undefined
      if (event.type === "session.next.step.failed") this.turnEnded(sessionID)
      else if (event.type === "session.next.step.ended" && finish !== "tool-calls") this.turnEnded(sessionID)
    }
  }

  private flush(link: Link): void {
    link.timer = undefined
    if (!this.links.has(link) || link.queue.length === 0) return
    const events = link.queue
    link.queue = []
    void link.send({ t: "evts", events }).catch(() => undefined)
  }
}
