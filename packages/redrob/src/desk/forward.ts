/**
 * The desk forwarder (redrob-mobile `docs/desk-relay.md`, section 4): what a paired device (the
 * phone app or a web browser) may ask of this daemon, and the live events it gets back.
 *
 * `ROUTES` is the only security boundary. A `req` outside it is answered 403 without touching the
 * daemon. A session created or prompted from any device, phone or web alike, is marked with
 * `MobileProfile.mark`, so saved approvals do not apply to it and its approval mode decides what asks.
 *
 * Approval modes: a `req` may carry `headers: { "X-Redrob-Approval": "ask" | "edits" | "all" }` on
 * session create and prompt. The mode is stored for that session and updated on every prompt; no
 * header means `ask` (old apps). `all` is allowed unless the launcher's switch was turned off; then it
 * is lowered to `edits`, and the `res` carries `headers: { "X-Redrob-Approval-Applied": "edits" }`.
 * When a session first gets `all`, one `auto_all_on` line is appended to `~/.redrob/desk/events.jsonl`
 * so the launcher can tell the person at the PC. `GET /desk/capabilities` is answered here, not by
 * the daemon: the modes this machine offers right now.
 *
 * Models: session create and prompt may also carry `X-Redrob-Model: <provider>/<model>` (the web's
 * chosen Redrob Console model `X` is `redrob/X`). When the daemon's catalog (`GET /api/model`) has it,
 * create gets it as the session's `model` and a prompt switches the session to it first
 * (`POST /api/session/:id/model`), so that turn runs on it; anything else is ignored and the session
 * keeps the PC's model. The `res` then carries `X-Redrob-Model-Applied`: the model the turn uses, or
 * `default` for the PC's default. `GET /desk/models` lists the catalog (id, name, imageInput).
 */
import { open } from "node:fs/promises"
import { MobileProfile } from "@redrob-code/core/permission/mobile"
import type { BusEvent, DaemonApi } from "./daemon"
import { MAX_RELAY_FRAME_BYTES } from "./frames"
import { allowAutoAll, appendEvent } from "./settings"

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
  /** Answered by the forwarder itself; never reaches the daemon. */
  readonly local?: "capabilities" | "attachment" | "models"
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
  { method: "GET", path: /^\/desk\/capabilities$/, local: "capabilities" },
  { method: "GET", path: /^\/desk\/models$/, local: "models" },
  // A file the session showed or handed to the user (`session.next.attachment`), in pieces.
  { method: "GET", path: new RegExp(`^/desk/attachment/${ID}/${ID}$`), query: true, local: "attachment" },
]

/** One attachment piece: at most this many bytes, which is also the default. */
export const ATTACHMENT_CHUNK_BYTES = 512 * 1024
/** Attachments kept per session; the oldest are forgotten first. */
const MAX_ATTACHMENTS_PER_SESSION = 200

export type Attachment = {
  readonly sessionID: string
  readonly id: string
  readonly name: string
  readonly mime: string
  readonly size: number
  readonly source: "read" | "share"
  readonly path: string
}

const isAttachment = (data: Record<string, unknown> | undefined): data is Attachment =>
  data !== undefined &&
  typeof data.sessionID === "string" &&
  typeof data.id === "string" &&
  typeof data.name === "string" &&
  typeof data.mime === "string" &&
  typeof data.size === "number" &&
  (data.source === "read" || data.source === "share") &&
  typeof data.path === "string"

/** `offset` and `limit` from a query string; undefined when either is not a whole number. */
function attachmentRange(path: string): { offset: number; limit: number } | undefined {
  const mark = path.indexOf("?")
  const query = new URLSearchParams(mark >= 0 ? path.slice(mark + 1) : "")
  const number = (name: string, fallback: number) => {
    const value = query.get(name)
    if (value === null) return fallback
    return /^\d{1,12}$/.test(value) ? Number(value) : undefined
  }
  const offset = number("offset", 0)
  const limit = number("limit", ATTACHMENT_CHUNK_BYTES)
  if (offset === undefined || limit === undefined) return undefined
  return { offset, limit: Math.min(Math.max(limit, 1), ATTACHMENT_CHUNK_BYTES) }
}

/** One piece of an attachment's file, base64. */
export async function readAttachment(
  attachment: Attachment,
  range: { offset: number; limit: number },
): Promise<{ name: string; mime: string; size: number; offset: number; data: string }> {
  const file = await open(attachment.path, "r")
  try {
    const size = (await file.stat()).size
    const offset = Math.min(range.offset, size)
    const buffer = Buffer.alloc(Math.min(range.limit, size - offset))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
    return { name: attachment.name, mime: attachment.mime, size, offset, data: buffer.subarray(0, bytesRead).toString("base64") }
  } finally {
    await file.close()
  }
}

/** `GET /desk/capabilities`: the approval modes this machine offers, read fresh each time. */
export async function capabilities(): Promise<{ v: 1; approvalModes: MobileProfile.ApprovalMode[]; defaultApproval: "edits" }> {
  const approvalModes: MobileProfile.ApprovalMode[] = (await allowAutoAll()) ? ["ask", "edits", "all"] : ["ask", "edits"]
  return { v: 1, approvalModes, defaultApproval: "edits" }
}

/** The mode a request asks for (`X-Redrob-Approval`, any case); `ask` when missing or unknown. */
function requestedMode(headers: unknown): MobileProfile.ApprovalMode | undefined {
  if (typeof headers !== "object" || headers === null) return undefined
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "x-redrob-approval") continue
    return MobileProfile.APPROVAL_MODES.includes(value as MobileProfile.ApprovalMode) ? (value as MobileProfile.ApprovalMode) : "ask"
  }
  return undefined
}

/** The mode a session actually gets: `all` unless the launcher's switch is off, then `edits`. */
async function appliedMode(requested: MobileProfile.ApprovalMode): Promise<MobileProfile.ApprovalMode> {
  if (requested !== "all") return requested
  return (await allowAutoAll()) ? "all" : "edits"
}

/** A model a device may ask for: `<provider>/<model>`, split at the first `/`. */
export type ModelRef = { readonly providerID: string; readonly id: string }

/** One `GET /desk/models` entry. `id` is `<provider>/<model>`, as `X-Redrob-Model` takes it. */
export type DeskModel = { readonly id: string; readonly name: string; readonly imageInput: boolean }

/** `X-Redrob-Model` value meaning "the PC's own default model". */
export const DEFAULT_MODEL = "default"

/** How long a read of the daemon's model catalog is reused. */
const MODELS_TTL_MS = 60_000

/** The raw `X-Redrob-Model` value (any case), or undefined when missing or not a string. */
export function requestedModel(headers: unknown): string | undefined {
  if (typeof headers !== "object" || headers === null) return undefined
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "x-redrob-model") continue
    return typeof value === "string" ? value.trim() : undefined
  }
  return undefined
}

/** `<provider>/<model>` as a ref; undefined for anything malformed. The model part may hold `/`. */
export function parseModel(value: string): ModelRef | undefined {
  if (value.length > 256) return undefined
  const slash = value.indexOf("/")
  if (slash <= 0) return undefined
  const providerID = value.slice(0, slash)
  const id = value.slice(slash + 1)
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(providerID)) return undefined
  if (!/^[A-Za-z0-9._:/@+-]{1,191}$/.test(id)) return undefined
  return { providerID, id }
}

const modelName = (ref: { providerID: string; id: string }) => `${ref.providerID}/${ref.id}`

/** The daemon's `GET /api/model` body as desk models; undefined when it is not a model list. */
export function deskModels(body: unknown): DeskModel[] | undefined {
  const data = (body as { data?: unknown } | undefined)?.data
  if (!Array.isArray(data)) return undefined
  const models: DeskModel[] = []
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue
    const model = item as { id?: unknown; providerID?: unknown; name?: unknown; capabilities?: { input?: unknown } }
    if (typeof model.id !== "string" || typeof model.providerID !== "string") continue
    const input = Array.isArray(model.capabilities?.input) ? model.capabilities.input : []
    models.push({
      id: modelName({ providerID: model.providerID, id: model.id }),
      name: typeof model.name === "string" ? model.name : model.id,
      imageInput: input.includes("image"),
    })
  }
  return models
}

/** A session's current model (`GET /api/session/:id` body), as `<provider>/<model>`, else `default`. */
function sessionModel(body: unknown): string {
  const model = (body as { data?: { model?: { providerID?: unknown; id?: unknown } } } | undefined)?.data?.model
  return typeof model?.providerID === "string" && typeof model.id === "string"
    ? modelName({ providerID: model.providerID, id: model.id })
    : DEFAULT_MODEL
}

/** Session list events, forwarded for every session so the phone's list stays current. */
const LIST_EVENTS = new Set(["session.created", "session.updated", "session.deleted"])
const COALESCE_MS = 100
/**
 * A device connecting warms the daemon's default location (`GET /api/model`), at most this often.
 * A cold location loads its model catalog, console `/models` included, on the first prompt and
 * the turn waits for it; warming it here moves that wait off the person's first prompt.
 */
const WARM_EVERY_MS = 5 * 60_000

/** The message of a `session.next.step.failed`, for the synthetic `session.idle` that ends the turn. */
function stepError(data: Record<string, unknown> | undefined): string | undefined {
  const message = (data?.error as { message?: unknown } | undefined)?.message
  return typeof message === "string" && message.length > 0 ? message.slice(0, 2000) : undefined
}

export type Request = { readonly method: Method; readonly path: string; readonly body?: unknown }

/** The route a request matches, and the session id it names; undefined when not allowed. */
export function match(request: Request): { route: Route; sessionID?: string; params: string[] } | undefined {
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
    return { route, sessionID: found[1], params: found.slice(1) }
  }
  return undefined
}

/** One paired, connected phone, as the relay hands it to the forwarder. */
export type Link = {
  /** Seal and send one `desk.msg` message. */
  send(message: Record<string, unknown>): Promise<void>
  subscriptions: Set<string>
  queue: BusEvent[]
  /** The device's name as the relay knows it, for the PC's `auto_all_on` note. */
  device?: string
  timer?: ReturnType<typeof setTimeout>
  /** When the last `evts` went out; an event after a quiet spell is sent at once. */
  flushed?: number
}

export type Notify = (kind: "done" | "approval", sessionId: string) => Promise<void>

export class Forwarder {
  private readonly links = new Set<Link>()
  private readonly waiting = new Set<string>()
  /** Sessions whose current step has called a tool. */
  private readonly toolStep = new Set<string>()
  /** Attachments announced on the bus, by session: the only files `/desk/attachment` serves. */
  private readonly attachments = new Map<string, Map<string, Attachment>>()
  private abort?: AbortController

  constructor(
    private readonly daemon: DaemonApi,
    private readonly notify: Notify,
    private readonly log: (message: string) => void,
  ) {}

  link(send: Link["send"], device?: string): Link {
    const link: Link = { send, subscriptions: new Set(), queue: [], ...(device ? { device } : {}) }
    this.links.add(link)
    this.warm()
    return link
  }

  private warmed = 0

  /** Boots the default location's catalog ahead of the first prompt (see WARM_EVERY_MS). */
  private warm(): void {
    const now = Date.now()
    if (now - this.warmed < WARM_EVERY_MS) return
    this.warmed = now
    void this.daemon.raw("GET", "/api/model").catch(() => undefined)
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
    if (route.local === "capabilities") return link.send({ t: "res", id, status: 200, body: await capabilities() })
    if (route.local === "attachment") return link.send({ t: "res", id, ...(await this.attachment(allowed.params, request.path)) })
    if (route.local === "models") {
      const models = await this.models()
      return link.send({ t: "res", id, ...(models ? { status: 200, body: { v: 1, models } } : { status: 503 }) })
    }
    const requested = route.mark ? requestedMode(value.headers) : undefined
    const mode = requested ? await appliedMode(requested) : "ask"
    const wantedModel = route.mark ? requestedModel(value.headers) : undefined
    const model = wantedModel !== undefined ? await this.applyModel(route, sessionID, request, wantedModel) : undefined
    const headers = {
      ...(requested && requested !== mode ? { "X-Redrob-Approval-Applied": mode } : {}),
      ...(model ? { "X-Redrob-Model-Applied": model.applied } : {}),
    }
    const body = model?.body !== undefined ? model.body : request.body
    const extra = Object.keys(headers).length > 0 ? { headers } : {}
    if (route.mark === "named" && sessionID) this.mark(link, sessionID, mode)
    const result = await this.daemon.raw(request.method, request.path, body).catch((error: unknown) => {
      this.log(`forward ${request.method} failed: ${error instanceof Error ? error.message : String(error)}`)
      return { status: 502, body: undefined }
    })
    const ok = result.status >= 200 && result.status < 300
    if (ok && route.mark === "created") {
      const created = (result.body as { data?: { id?: unknown } } | undefined)?.data?.id
      if (typeof created === "string") this.mark(link, created, mode)
    }
    if (ok && route.prompt && sessionID) this.watchTurn(sessionID)
    // A stop may leave no step.ended behind; the phone's stop must still end the turn.
    if (ok && sessionID && request.method === "POST" && request.path.endsWith("/interrupt")) this.turnEnded(sessionID)
    // The relay drops a frame over 8 MB and the phone would wait forever. Say 413 instead;
    // the phone asks for a smaller history page.
    if (result.body !== undefined && Buffer.byteLength(JSON.stringify(result.body)) > MAX_BODY_BYTES) {
      return link.send({ t: "res", id, status: 413, ...extra })
    }
    await link.send({ t: "res", id, status: result.status, ...extra, ...(result.body !== undefined ? { body: result.body } : {}) })
  }

  private catalog?: { at: number; models: DeskModel[] }

  /** The daemon's model catalog, reused for MODELS_TTL_MS; undefined when it cannot be read. */
  async models(fresh = false): Promise<DeskModel[] | undefined> {
    if (!fresh && this.catalog && Date.now() - this.catalog.at < MODELS_TTL_MS) return this.catalog.models
    const result = await this.daemon.raw("GET", "/api/model").catch(() => undefined)
    const models = result && result.status >= 200 && result.status < 300 ? deskModels(result.body) : undefined
    if (!models) return undefined
    // An empty list is a location still booting; read again next time.
    if (models.length > 0) this.catalog = { at: Date.now(), models }
    return models
  }

  /**
   * `X-Redrob-Model` on session create or prompt. A model the catalog has goes into the create body,
   * or the session is switched to it before the prompt. Anything else changes nothing: the session
   * keeps the model it has (`default` when it has none, the PC's default). Returns the applied model,
   * and the create body to send instead when it changed.
   */
  private async applyModel(
    route: Route,
    sessionID: string | undefined,
    request: Request,
    wanted: string,
  ): Promise<{ applied: string; body?: unknown }> {
    const ref = parseModel(wanted)
    const has = (models: DeskModel[] | undefined) => models?.some((model) => model.id === modelName(ref!)) === true
    // A model added since the cached read is found on a fresh one.
    const known = ref ? has(await this.models()) || has(await this.models(true)) : false
    if (route.mark === "created") {
      const body = typeof request.body === "object" && request.body !== null ? (request.body as Record<string, unknown>) : {}
      if (ref && known) return { applied: modelName(ref), body: { ...body, model: { id: ref.id, providerID: ref.providerID } } }
      if (wanted !== DEFAULT_MODEL) this.log(`model ${JSON.stringify(wanted.slice(0, 80))} is not on this PC; using its default`)
      return { applied: sessionModel({ data: body }) }
    }
    if (!sessionID) return { applied: DEFAULT_MODEL }
    if (ref && known) {
      const switched = await this.daemon
        .raw("POST", `/api/session/${sessionID}/model`, { model: { id: ref.id, providerID: ref.providerID } })
        .catch(() => ({ status: 502 }))
      if (switched.status >= 200 && switched.status < 300) return { applied: modelName(ref) }
      this.log(`model switch failed: ${switched.status}`)
    } else if (wanted !== DEFAULT_MODEL) {
      this.log(`model ${JSON.stringify(wanted.slice(0, 80))} is not on this PC; keeping the session's model`)
    }
    const current = await this.daemon.raw("GET", `/api/session/${sessionID}`).catch(() => undefined)
    return { applied: sessionModel(current?.body) }
  }

  /** `GET /desk/attachment/:sessionID/:id`: a piece of an announced attachment, 404 for anything else. */
  async attachment(params: string[], path: string): Promise<{ status: number; body?: unknown }> {
    const [sessionID, attachmentID] = params
    const attachment = sessionID && attachmentID ? this.attachments.get(sessionID)?.get(attachmentID) : undefined
    if (!attachment) return { status: 404 }
    const range = attachmentRange(path)
    if (!range) return { status: 400 }
    return readAttachment(attachment, range).then(
      (body) => ({ status: 200, body }),
      (error: unknown) => {
        this.log(`attachment read failed: ${error instanceof Error ? error.message : String(error)}`)
        return { status: 404 }
      },
    )
  }

  /** Remember an attachment the bus announced. */
  private remember(attachment: Attachment): void {
    let session = this.attachments.get(attachment.sessionID)
    if (!session) {
      session = new Map()
      this.attachments.set(attachment.sessionID, session)
    }
    session.set(attachment.id, attachment)
    if (session.size > MAX_ATTACHMENTS_PER_SESSION) session.delete(session.keys().next().value!)
  }

  /** Mark a session, and note on the PC when it first turns to `all`. */
  private mark(link: Link, sessionID: string, mode: MobileProfile.ApprovalMode): void {
    const first = mode === "all" && !(MobileProfile.isMobile(sessionID) && MobileProfile.mode(sessionID) === "all")
    MobileProfile.mark(sessionID, mode)
    if (!first) return
    void appendEvent({ type: "auto_all_on", sessionId: sessionID, ...(link.device ? { device: link.device } : {}) }).catch(
      (error: unknown) => this.log(`events.jsonl write failed: ${error instanceof Error ? error.message : String(error)}`),
    )
  }

  /**
   * After a phone prompt: when the turn ends, tell subscribed phones with a synthetic
   * `session.idle` event (the bus carries none; a failed turn adds `error`, the step's message), and
   * push "done" when no phone is watching.
   *
   * The turn's end is read off the bus: `session.next.step.failed`, or `session.next.step.ended`
   * whose finish is not a tool call and whose step called no tool (a tool call starts another
   * step; some models still report "stop" for it). `POST /api/session/:id/wait`
   * is not used: V2 sessions answer it 503 "Session wait is not available yet", so the phone never
   * heard the turn end and showed "working" forever, and stop could not end it either.
   */
  private watchTurn(sessionID: string): void {
    this.waiting.add(sessionID)
  }

  private turnEnded(sessionID: string, error?: string): void {
    this.toolStep.delete(sessionID)
    if (!this.waiting.delete(sessionID)) return
    this.onEvent({ type: "session.idle", data: { sessionID, ...(error ? { error } : {}) } })
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
    if (event.type === "session.next.attachment" && isAttachment(event.data)) this.remember(event.data)
    if (event.type === "permission.v2.asked" && sessionID && MobileProfile.isMobile(sessionID) && !this.watched(sessionID)) {
      void this.notify("approval", sessionID).catch(() => undefined)
    }
    for (const link of this.links) {
      const wanted = permission || LIST_EVENTS.has(event.type) || (sessionID !== undefined && link.subscriptions.has(sessionID))
      if (!wanted) continue
      link.queue.push(event)
      if (link.timer) continue
      // Leading edge: the first event after a quiet spell goes now, later ones wait for the window.
      const wait = (link.flushed ?? 0) + COALESCE_MS - Date.now()
      link.timer = setTimeout(() => this.flush(link), Math.max(wait, 0))
    }
    if (sessionID && this.waiting.has(sessionID)) {
      const finish = typeof event.data?.finish === "string" ? event.data.finish : undefined
      if (event.type === "session.next.step.started") this.toolStep.delete(sessionID)
      else if (event.type === "session.next.tool.input.started" || event.type === "session.next.tool.called") this.toolStep.add(sessionID)
      else if (event.type === "session.next.step.failed") this.turnEnded(sessionID, stepError(event.data))
      // Some console models finish a tool step with "stop"/"other"; a step that called a tool is not the end.
      else if (event.type === "session.next.step.ended" && finish !== "tool-calls" && !this.toolStep.has(sessionID)) this.turnEnded(sessionID)
    }
  }

  private flush(link: Link): void {
    link.timer = undefined
    if (!this.links.has(link) || link.queue.length === 0) return
    const events = link.queue
    link.queue = []
    link.flushed = Date.now()
    void link.send({ t: "evts", events }).catch(() => undefined)
  }
}
