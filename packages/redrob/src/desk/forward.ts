/**
 * The desk forwarder (redrob-mobile `docs/desk-relay.md`, section 5): what a paired device (the
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
 *
 * Machines: a `req` may carry `machineId`; one that is not this machine's is answered 421 and not
 * run (no `machineId`: this machine, as before). This machine's access (`~/.redrob/desk/settings.json`
 * `machine.access`) is checked on every `req`: `read_only` answers every POST 403 with
 * `X-Redrob-Machine-Access: read_only`; `ask` lowers `all` to `edits`, so commands ask;
 * `trusted` (the default) lets `all` through while the launcher's switch is on. `GET /desk/capabilities` also
 * reports `machineId` and `access`.
 *
 * Privacy (the web's AI 방화벽 "strong"): `GET` / `PUT /api/privacy` read and set the PC's masking
 * (`{ mode, model }`), and `POST /api/privacy/mask` masks a message on the PC before it leaves the
 * browser. A body these reject is answered 400, as the daemon would. Masking changes nothing on the
 * PC, so a `read_only` machine answers it too. `GET /desk/capabilities` reports
 * `privacy: { model, localModels }`: the configured masking model and the models a local provider
 * (Ollama, LM Studio, or a base URL on localhost / 127.0.0.1) serves.
 *
 * Files (Redrob Chat's PC folder tools): `GET /desk/files/find?name=`, `/desk/files/list?path=` and
 * `/desk/files/read?path=&offset=&limit=` are answered here from the folders the person allowed in
 * Redrob Desktop; a folder outside them is asked about at the PC first (files.ts).
 *
 * Code work (redrob-chat docs code-work contract 2): the engine's `/file*`, `/find*`, `/command`
 * and `/pty*` routes pass for a session's work folder only (`?directory=`, roots.ts); `/pty*` is
 * refused on a `read_only` machine, and the PTY websocket rides `{ t: "stream" }` messages
 * (stream.ts). `/desk/file/content|write|rename|delete` are the editor's (write.ts). Session create
 * may carry `branch` / `repo` (a worktree, worktree.ts) and `skills` (skills.ts). A device that
 * opened a work folder gets that folder's `file.watcher.updated` events. `GET /desk/capabilities`
 * lists `features`.
 */
import { open, realpath } from "node:fs/promises"
import path from "node:path"
import { MobileProfile } from "@redrob-code/core/permission/mobile"
import { consoleModelID } from "@redrob-code/core/plugin/provider/redrob-constants"
import { SessionID } from "@redrob-code/schema/session-id"
import type { BusEvent, DaemonApi } from "./daemon"
import { filesRequest } from "./files"
import { MAX_RELAY_FRAME_BYTES } from "./frames"
import { Roots, absolute, queryOf, within } from "./roots"
import { allowAutoAll, appendEvent, machine, type MachineAccess } from "./settings"
import { SessionSkills, SkillsError, parseSkills, type PushedSkill } from "./skills"
import { Streams } from "./stream"
import { WorktreeError, prepare } from "./worktree"
import { fileRequest, type WriteOp } from "./write"

/** Room for the frame header and the seal on top of the JSON. */
const MAX_BODY_BYTES = MAX_RELAY_FRAME_BYTES - 64 * 1024

export type Method = "GET" | "POST" | "PUT" | "DELETE"

type Route = {
  readonly method: Method
  readonly path: RegExp
  /** A POST that changes nothing on the PC, so a `read_only` machine answers it too. */
  readonly readOnly?: true
  /** Refused on a `read_only` machine even as a GET (a terminal can change anything). */
  readonly writes?: true
  /** `?directory=` must be a session's work folder (roots.ts); `?workspace=` is refused. */
  readonly root?: true
  /** Whether a query string is passed through. */
  readonly query?: boolean
  /** Extra body rule; false answers 403, or `invalidBody` when set. */
  readonly body?: (body: unknown) => boolean
  /** The status a body failing `body` gets, for routes whose daemon contract says 400. */
  readonly invalidBody?: 400
  /** Mark the session the call names (capture 1) or creates (`created`). */
  readonly mark?: "named" | "created"
  /** A phone prompt: watch the turn so its end can be pushed. */
  readonly prompt?: boolean
  /** Answered by the forwarder itself; never reaches the daemon. */
  readonly local?: "capabilities" | "attachment" | "models" | "files" | "file" | "skills"
  /** Which `/desk/files/*` call (files.ts), for `local: "files"`. */
  readonly files?: "find" | "list" | "read"
  /** Which `/desk/file/*` call (write.ts), for `local: "file"`. */
  readonly file?: WriteOp
}

/** What this desk adds for code work (code-work contract 2.1); the web shows a feature only when listed. */
export const FEATURES = ["files", "files.write", "pty", "commands", "worktree", "skills.push"] as const

/** `POST /pty`: a terminal in the work folder, `{ command?, args?, cwd?, title? }`, nothing else. */
function isPtyCreate(body: unknown): boolean {
  if (body === undefined) return true
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false
  const { command, args, cwd, title, ...rest } = body as Record<string, unknown>
  if (Object.keys(rest).length > 0) return false
  const short = (value: unknown, max = 4096) => value === undefined || (typeof value === "string" && value.length <= max)
  return (
    short(command) &&
    short(cwd) &&
    short(title, 200) &&
    (args === undefined || (Array.isArray(args) && args.length <= 64 && args.every((arg) => short(arg))))
  )
}

/** `PUT /pty/:id`: `{ title?, size?: { rows, cols } }`. */
function isPtyUpdate(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false
  const { title, size, ...rest } = body as Record<string, unknown>
  if (Object.keys(rest).length > 0) return false
  if (title !== undefined && (typeof title !== "string" || title.length > 200)) return false
  if (size === undefined) return true
  const { rows, cols } = (size ?? {}) as { rows?: unknown; cols?: unknown }
  const dimension = (value: unknown) => Number.isInteger(value) && (value as number) > 0 && (value as number) <= 2000
  return dimension(rows) && dimension(cols)
}

/** The websocket paths a device may open as a relay stream (stream.ts). */
const STREAMS: readonly RegExp[] = [/^\/pty\/([A-Za-z0-9_-]{1,128})\/connect$/]

/** One path segment of an id. Nothing that can climb or re-encode a path. */
const ID = "([A-Za-z0-9_-]{1,128})"

/**
 * The allowlist. Keep in step with redrob-mobile docs/desk-relay.md, section 5. `history` also passes its query
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
  // AI 방화벽 "strong": the web reads and sets the PC's masking, and masks a message on the PC first.
  { method: "GET", path: /^\/api\/privacy$/ },
  { method: "PUT", path: /^\/api\/privacy$/, body: (body) => isPrivacySettings(body), invalidBody: 400 },
  {
    method: "POST",
    path: /^\/api\/privacy\/mask$/,
    body: (body) => isMaskBody(body),
    invalidBody: 400,
    readOnly: true,
  },
  { method: "GET", path: /^\/desk\/capabilities$/, local: "capabilities" },
  { method: "GET", path: /^\/desk\/models$/, local: "models" },
  // A file the session showed or handed to the user (`session.next.attachment`), in pieces.
  { method: "GET", path: new RegExp(`^/desk/attachment/${ID}/${ID}$`), query: true, local: "attachment" },
  // The person's own files for Redrob Chat (files.ts): only allowed folders; others are asked at the PC.
  { method: "GET", path: /^\/desk\/files\/find$/, query: true, local: "files", files: "find" },
  { method: "GET", path: /^\/desk\/files\/list$/, query: true, local: "files", files: "list" },
  { method: "GET", path: /^\/desk\/files\/read$/, query: true, local: "files", files: "read" },
  // Code work (code-work design 10): a session's work folder, by `?directory=`. Its files, search
  // and commands are the engine's own routes; a read-only machine answers them too.
  { method: "GET", path: /^\/file$/, query: true, root: true },
  { method: "GET", path: /^\/file\/content$/, query: true, root: true },
  { method: "GET", path: /^\/file\/status$/, query: true, root: true },
  { method: "GET", path: /^\/find$/, query: true, root: true },
  { method: "GET", path: /^\/find\/file$/, query: true, root: true },
  { method: "GET", path: /^\/find\/symbol$/, query: true, root: true },
  { method: "GET", path: /^\/command$/, query: true, root: true },
  // The person's terminal in it (the websocket rides relay streams, stream.ts). No read-only terminal.
  { method: "GET", path: /^\/pty\/shells$/, query: true, root: true, writes: true },
  { method: "GET", path: /^\/pty$/, query: true, root: true, writes: true },
  { method: "POST", path: /^\/pty$/, query: true, root: true, writes: true, body: isPtyCreate, invalidBody: 400 },
  { method: "GET", path: new RegExp(`^/pty/${ID}$`), query: true, root: true, writes: true },
  {
    method: "PUT",
    path: new RegExp(`^/pty/${ID}$`),
    query: true,
    root: true,
    writes: true,
    body: isPtyUpdate,
    invalidBody: 400,
  },
  { method: "DELETE", path: new RegExp(`^/pty/${ID}$`), query: true, root: true, writes: true },
  // The panel's editor: content with its hash, and saving, renaming, deleting (write.ts).
  { method: "GET", path: /^\/desk\/file\/content$/, query: true, local: "file", file: "content" },
  { method: "POST", path: /^\/desk\/file\/write$/, local: "file", file: "write" },
  { method: "POST", path: /^\/desk\/file\/rename$/, local: "file", file: "rename" },
  { method: "POST", path: /^\/desk\/file\/delete$/, local: "file", file: "delete" },
  // The chat's skills this desk holds, so it sends a skill's files only once (skills.ts).
  { method: "GET", path: /^\/desk\/skills$/, local: "skills" },
]

/** `PUT /api/privacy` body: `{ mode, model? }`, nothing else. */
function isPrivacySettings(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false
  const { mode, model, ...rest } = body as { mode?: unknown; model?: unknown }
  if (Object.keys(rest).length > 0) return false
  if (mode !== "off" && mode !== "regex" && mode !== "model") return false
  return model === undefined || (typeof model === "string" && parseModel(model) !== undefined)
}

/** `POST /api/privacy/mask` body: `{ texts }`, 1 to 50 strings of at most 100000 characters. */
function isMaskBody(body: unknown): boolean {
  const texts = (body as { texts?: unknown } | undefined)?.texts
  return (
    typeof body === "object" &&
    body !== null &&
    Object.keys(body).length === 1 &&
    Array.isArray(texts) &&
    texts.length >= 1 &&
    texts.length <= 50 &&
    texts.every((text) => typeof text === "string" && text.length <= 100_000)
  )
}

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
    return {
      name: attachment.name,
      mime: attachment.mime,
      size,
      offset,
      data: buffer.subarray(0, bytesRead).toString("base64"),
    }
  } finally {
    await file.close()
  }
}

/**
 * `GET /desk/capabilities` `privacy`: the local model masking uses (`privacy.model`), and the
 * `<provider>/<model>` ids this PC serves from a LOCAL provider, the ones it may pick from.
 */
export type DeskPrivacy = { readonly model: string | null; readonly localModels: string[] }

const NO_PRIVACY: DeskPrivacy = { model: null, localModels: [] }

/** `GET /desk/capabilities`: the approval modes this machine offers, read fresh each time. */
export async function capabilities(privacy: DeskPrivacy = NO_PRIVACY): Promise<{
  v: 1
  approvalModes: MobileProfile.ApprovalMode[]
  defaultApproval: "edits"
  machineId: string
  access: MachineAccess
  privacy: DeskPrivacy
  features: string[]
}> {
  const self = await machine()
  const approvalModes: MobileProfile.ApprovalMode[] =
    self.access === "read_only"
      ? []
      : self.access === "trusted" && (await allowAutoAll())
        ? ["ask", "edits", "all"]
        : ["ask", "edits"]
  return {
    v: 1,
    approvalModes,
    defaultApproval: "edits",
    machineId: self.id,
    access: self.access,
    privacy,
    features: [...FEATURES],
  }
}

/** The mode a request asks for (`X-Redrob-Approval`, any case); `ask` when missing or unknown. */
function requestedMode(headers: unknown): MobileProfile.ApprovalMode | undefined {
  if (typeof headers !== "object" || headers === null) return undefined
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "x-redrob-approval") continue
    return MobileProfile.APPROVAL_MODES.includes(value as MobileProfile.ApprovalMode)
      ? (value as MobileProfile.ApprovalMode)
      : "ask"
  }
  return undefined
}

/**
 * The mode a session actually gets. `all` needs this machine's access `trusted` and the launcher's
 * switch on; otherwise it is lowered to `edits`, where commands still ask.
 */
async function appliedMode(
  requested: MobileProfile.ApprovalMode,
  access: MachineAccess,
): Promise<MobileProfile.ApprovalMode> {
  if (requested !== "all") return requested
  return access === "trusted" && (await allowAutoAll()) ? "all" : "edits"
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

/**
 * `<provider>/<model>` as a ref; undefined for anything malformed. The model part may hold `/`.
 * The retired `redrob/auto` an older app still sends becomes the default redrob model.
 */
export function parseModel(value: string): ModelRef | undefined {
  if (value.length > 256) return undefined
  const slash = value.indexOf("/")
  if (slash <= 0) return undefined
  const providerID = value.slice(0, slash)
  const id = value.slice(slash + 1)
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(providerID)) return undefined
  if (!/^[A-Za-z0-9._:/@+-]{1,191}$/.test(id)) return undefined
  return { providerID, id: providerID === "redrob" ? consoleModelID(id) : id }
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

/** Providers that only ever run on this machine, whatever their configured URL. */
const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio"])
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/** Whether a base URL points at this machine. */
function isLocalUrl(url: unknown): boolean {
  if (typeof url !== "string") return false
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * The ids (`<provider>/<model>`) in a `GET /api/model` body that a local provider serves: Ollama,
 * LM Studio, or any provider whose base URL is localhost / 127.0.0.1. Masking may only use these,
 * so the text it reads never leaves the PC.
 */
export function localModels(body: unknown): string[] {
  const data = (body as { data?: unknown } | undefined)?.data
  if (!Array.isArray(data)) return []
  return data.flatMap((item) => {
    if (typeof item !== "object" || item === null) return []
    const model = item as { id?: unknown; providerID?: unknown; api?: { url?: unknown } }
    if (typeof model.id !== "string" || typeof model.providerID !== "string") return []
    return LOCAL_PROVIDERS.has(model.providerID) || isLocalUrl(model.api?.url)
      ? [modelName({ providerID: model.providerID, id: model.id })]
      : []
  })
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
/** Events after which the machine's running-session or approval count may differ. */
const ACTIVITY_EVENTS = new Set([
  "permission.v2.asked",
  "permission.v2.replied",
  "session.next.step.started",
  "session.next.step.ended",
  "session.next.step.failed",
  "session.deleted",
])
const COALESCE_MS = 100

/** The engine's file watcher event (`{ file, event: "add" | "change" | "unlink" }`), passed on as is. */
const WATCHER_EVENT = "file.watcher.updated"

/** The absolute file a watcher event names; undefined when it names none. */
function watchedFile(event: BusEvent): string | undefined {
  const file = event.data?.file
  if (typeof file !== "string" || file.length === 0) return undefined
  if (path.isAbsolute(file)) return path.resolve(file)
  const directory = (event as { location?: { directory?: unknown } }).location?.directory
  return typeof directory === "string" ? path.resolve(directory, file) : undefined
}
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
/** The status for a request `match` refused: 400 when only its body broke a route's `invalidBody` rule. */
export function refusal(request: Request): 400 | 403 {
  if (typeof request.path !== "string") return 403
  const mark = request.path.indexOf("?")
  const pathname = mark >= 0 ? request.path.slice(0, mark) : request.path
  const bad = ROUTES.some((route) => route.invalidBody && route.method === request.method && route.path.test(pathname))
  return bad ? 400 : 403
}

export function match(request: Request): { route: Route; sessionID?: string; params: string[] } | undefined {
  if (request.method !== "GET" && request.method !== "POST" && request.method !== "PUT" && request.method !== "DELETE")
    return undefined
  if (typeof request.path !== "string" || request.path.length > 2048 || !request.path.startsWith("/")) return undefined
  const mark = request.path.indexOf("?")
  const pathname = mark >= 0 ? request.path.slice(0, mark) : request.path
  if ((request.method === "GET" || request.method === "DELETE") && request.body !== undefined) return undefined
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
  /** Work folders the device opened files, search or a terminal in: their `file.watcher.updated` events go to it. */
  watching?: Set<string>
  /** Its open terminal streams (stream.ts). */
  streams?: Streams
}

/** A work folder a device watches at most this many of; the oldest is dropped. */
const MAX_WATCHING = 32

export type Notify = (kind: "done" | "approval", sessionId: string) => Promise<void>

export class Forwarder {
  private readonly links = new Set<Link>()
  private readonly waiting = new Set<string>()
  /** Sessions whose current step has called a tool. */
  private readonly toolStep = new Set<string>()
  /** Attachments announced on the bus, by session: the only files `/desk/attachment` serves. */
  private readonly attachments = new Map<string, Map<string, Attachment>>()
  /** Permission requests asked on the bus and not answered yet, for `desk.machine`. */
  private readonly asked = new Set<string>()
  /** The work folders of sessions here: the only folders the file, find, command and terminal routes reach. */
  readonly roots: Roots
  /** The chat's skills, written per session (skills.ts). */
  readonly skills = new SessionSkills()
  private abort?: AbortController

  constructor(
    private readonly daemon: DaemonApi,
    private readonly notify: Notify,
    private readonly log: (message: string) => void,
    /** Called when a turn or a permission request may have started or ended (`desk.machine`). */
    private readonly onActivity: () => void = () => {},
  ) {
    this.roots = new Roots(daemon)
  }

  /** Permission requests waiting for an answer, as far as the bus has said since the forwarder started. */
  approvals(): number {
    return this.asked.size
  }

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
    link.streams?.closeAll()
    this.links.delete(link)
  }

  /** The device now works in this folder: send it the folder's file changes. */
  private watch(link: Link, root: string): void {
    link.watching ??= new Set()
    link.watching.delete(root)
    link.watching.add(root)
    if (link.watching.size > MAX_WATCHING) link.watching.delete(link.watching.values().next().value!)
  }

  /**
   * A route with `root`: `?directory=` must be a session's work folder and `?workspace=` is not
   * passed (it would route elsewhere). The folder, or undefined to refuse with 403.
   */
  private async root(request: Request): Promise<string | undefined> {
    const query = queryOf(request.path)
    if (query.has("workspace") || query.getAll("directory").length !== 1) return undefined
    const root = await this.roots.root(query.get("directory"))
    if (!root) return undefined
    // A terminal's start folder must be inside it too.
    const cwd = (request.body as { cwd?: unknown } | undefined)?.cwd
    if (request.method === "POST" && cwd !== undefined) {
      const inside = absolute(cwd)
      if (!inside || !within(root, inside)) return undefined
      const [realRoot, realCwd] = await Promise.all([
        realpath(root).catch(() => root),
        realpath(inside).catch(() => undefined),
      ])
      if (!realCwd || !within(realRoot, realCwd)) return undefined
    }
    return root
  }

  /** `{ t: "stream", ... }` from a device (stream.ts). */
  private async stream(link: Link, value: Record<string, unknown>): Promise<void> {
    const sid = value.sid
    if (typeof sid !== "number" || !Number.isInteger(sid) || sid < 0) return
    if (value.op !== "open") return link.streams?.input(sid, value.op, value.data)
    const refuse = (status: number) => link.send({ t: "stream", op: "open", sid, status })
    const self = await machine()
    if (value.machineId !== undefined && value.machineId !== self.id) return refuse(421)
    if (self.access === "read_only") return refuse(403)
    const path = typeof value.path === "string" && value.path.length <= 2048 ? value.path : ""
    const mark = path.indexOf("?")
    const pathname = mark >= 0 ? path.slice(0, mark) : path
    if (!STREAMS.some((pattern) => pattern.test(pathname))) return refuse(403)
    const root = await this.root({ method: "GET", path })
    if (!root) return refuse(403)
    // Only what the PTY route reads: the folder and the replay cursor.
    const query = queryOf(path)
    const cursor = query.get("cursor")
    if ([...query.keys()].some((key) => key !== "directory" && key !== "cursor")) return refuse(403)
    if (cursor !== null && !/^-?\d{1,15}$/.test(cursor)) return refuse(400)
    this.watch(link, root)
    link.streams ??= new Streams(this.daemon, (message) => link.send(message))
    const status = await link.streams.start(sid, path)
    await refuse(status)
  }

  /**
   * Session create with code-work fields (contract 2.2): `branch` / `repo` put the session in a
   * worktree (worktree.ts), `skills` in its own skill folder (skills.ts). Both are taken out of the
   * body the daemon gets. Returns the body, extra response headers, a status to answer instead, and
   * what to do once the daemon answered.
   */
  private async codeWork(body: unknown): Promise<{
    body: unknown
    headers: Record<string, string>
    refuse?: { status: number; body?: unknown }
    after?: (ok: boolean, created: string | undefined) => Promise<void>
  }> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return { body, headers: {} }
    const { branch, repo, skills: rawSkills, ...rest } = body as Record<string, unknown>
    if (branch === undefined && repo === undefined && rawSkills === undefined) return { body, headers: {} }
    let skills: PushedSkill[]
    try {
      skills = parseSkills(rawSkills)
    } catch (error) {
      if (error instanceof SkillsError) return { body, headers: {}, refuse: { status: error.status, body: error.body } }
      throw error
    }
    const missing = this.skills.missing(skills)
    if (missing.length > 0) return { body, headers: {}, refuse: { status: 409, body: { missingSkills: missing } } }

    const location = (rest.location ?? {}) as { directory?: unknown; workspaceID?: unknown }
    const headers: Record<string, string> = {}
    let directory = typeof location.directory === "string" ? location.directory : undefined
    let fresh = false
    if (branch !== undefined || repo !== undefined) {
      try {
        const worktree = await prepare({ branch, repo, directory })
        directory = worktree.directory
        fresh = worktree.created
        this.roots.add(worktree.directory)
        headers["X-Redrob-Worktree"] = worktree.directory
        headers["X-Redrob-Branch"] = worktree.branch
      } catch (error) {
        if (error instanceof WorktreeError)
          return { body, headers: {}, refuse: { status: error.status, body: { reason: error.message } } }
        throw error
      }
      rest.location = { ...location, directory }
    }
    if (skills.length === 0) return { body: rest, headers }
    if (!directory) return { body, headers: {}, refuse: { status: 400, body: { reason: "skills need a location directory" } } }
    // The folder is per session, so the id is known before the daemon makes the session.
    const sessionID = typeof rest.id === "string" ? rest.id : SessionID.create()
    rest.id = sessionID
    await this.skills.write(directory, sessionID, skills)
    headers["X-Redrob-Skills"] = String(skills.length)
    const work = directory
    return {
      body: rest,
      headers,
      after: async (ok) => {
        if (!ok) {
          await this.skills.remove(sessionID)
          return
        }
        // A folder whose location was open already keeps the skills it read; reopen it when idle.
        if (!fresh) await this.reopen(work).catch(() => undefined)
      },
    }
  }

  /** Reopen a folder's location so it reads its skills again, unless a turn runs there. */
  private async reopen(directory: string): Promise<void> {
    const active = await this.daemon.raw("GET", "/api/session/active")
    const running = Object.keys(((active.body as { data?: unknown } | undefined)?.data ?? {}) as object)
    for (const id of running) {
      const session = await this.daemon.raw("GET", `/api/session/${encodeURIComponent(id)}`).catch(() => undefined)
      const where = (session?.body as { data?: { location?: { directory?: unknown } } } | undefined)?.data?.location
      if (where?.directory === directory) return
    }
    await this.daemon.raw("POST", `/instance/dispose?${new URLSearchParams({ directory })}`)
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
      const sessions = Array.isArray(value.sessions)
        ? value.sessions.filter((id): id is string => typeof id === "string")
        : []
      link.subscriptions = new Set(sessions.slice(0, 200))
      return
    }
    if (value.t === "stream") return this.stream(link, value)
    if (value.t !== "req" || typeof value.id !== "number" || !Number.isInteger(value.id)) return
    const id = value.id
    const self = await machine()
    // A request addressed to another machine is not run here (421 Misdirected Request).
    // No `machineId` means this machine, as before.
    if (value.machineId !== undefined && value.machineId !== self.id) return link.send({ t: "res", id, status: 421 })
    const request = { method: value.method, path: value.path, body: value.body } as Request
    const allowed = match(request)
    if (!allowed) return link.send({ t: "res", id, status: refusal(request) })
    // A read-only machine answers reads only (and POSTs that change nothing, like masking a text).
    if (
      self.access === "read_only" &&
      ((request.method !== "GET" && !allowed.route.readOnly) || allowed.route.writes)
    ) {
      return link.send({ t: "res", id, status: 403, headers: { "X-Redrob-Machine-Access": self.access } })
    }

    const { route, sessionID } = allowed
    if (route.root) {
      const root = await this.root(request)
      if (!root) return link.send({ t: "res", id, status: 403 })
      this.watch(link, root)
    }
    if (route.local === "file" && route.file) {
      const result = await fileRequest(this.roots, route.file, request.path, request.body)
      const folder = (request.body as { directory?: unknown } | undefined)?.directory ?? queryOf(request.path).get("directory")
      const root = result.status < 300 && folder ? await this.roots.root(folder) : undefined
      if (root) this.watch(link, root)
      return link.send({ t: "res", id, ...result })
    }
    if (route.local === "skills") return link.send({ t: "res", id, status: 200, body: { v: 1, skills: this.skills.list() } })
    if (route.local === "capabilities")
      return link.send({ t: "res", id, status: 200, body: await capabilities(await this.privacy()) })
    if (route.local === "attachment")
      return link.send({ t: "res", id, ...(await this.attachment(allowed.params, request.path)) })
    if (route.local === "files" && route.files)
      return link.send({ t: "res", id, ...(await filesRequest(route.files, request.path, link.device)) })
    if (route.local === "models") {
      const models = await this.models()
      return link.send({ t: "res", id, ...(models ? { status: 200, body: { v: 1, models } } : { status: 503 }) })
    }
    // Session create may ask for a worktree and the chat's skills; the daemon gets the body without them.
    const work = route.mark === "created" ? await this.codeWork(request.body) : undefined
    if (work?.refuse) return link.send({ t: "res", id, ...work.refuse })
    const forwarded = work ? { ...request, body: work.body } : request
    const requested = route.mark ? requestedMode(value.headers) : undefined
    const mode = requested ? await appliedMode(requested, self.access) : "ask"
    const wantedModel = route.mark ? requestedModel(value.headers) : undefined
    const model =
      wantedModel !== undefined ? await this.applyModel(route, sessionID, forwarded, wantedModel) : undefined
    const headers = {
      ...(requested && requested !== mode ? { "X-Redrob-Approval-Applied": mode } : {}),
      ...(model ? { "X-Redrob-Model-Applied": model.applied } : {}),
      ...work?.headers,
    }
    const body = model?.body !== undefined ? model.body : forwarded.body
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
      const where = (result.body as { data?: { location?: { directory?: unknown } } } | undefined)?.data?.location
      if (typeof where?.directory === "string") this.roots.add(where.directory)
    }
    if (work?.after) {
      const created = (result.body as { data?: { id?: unknown } } | undefined)?.data?.id
      await work.after(ok, typeof created === "string" ? created : undefined).catch((error: unknown) =>
        this.log(`code work setup failed: ${error instanceof Error ? error.message : String(error)}`),
      )
    }
    if (ok && route.prompt && sessionID) this.watchTurn(sessionID)
    // A stop may leave no step.ended behind; the phone's stop must still end the turn.
    if (ok && sessionID && request.method === "POST" && request.path.endsWith("/interrupt")) this.turnEnded(sessionID)
    // The relay drops a frame over 8 MB and the phone would wait forever. Say 413 instead;
    // the phone asks for a smaller history page.
    if (result.body !== undefined && Buffer.byteLength(JSON.stringify(result.body)) > MAX_BODY_BYTES) {
      return link.send({ t: "res", id, status: 413, ...extra })
    }
    await link.send({
      t: "res",
      id,
      status: result.status,
      ...extra,
      ...(result.body !== undefined ? { body: result.body } : {}),
    })
  }

  private catalog?: { at: number; models: DeskModel[]; local: string[] }

  /** The daemon's model catalog and its local model ids, reused for MODELS_TTL_MS; undefined when it cannot be read. */
  private async read(fresh = false): Promise<{ models: DeskModel[]; local: string[] } | undefined> {
    if (!fresh && this.catalog && Date.now() - this.catalog.at < MODELS_TTL_MS) return this.catalog
    const result = await this.daemon.raw("GET", "/api/model").catch(() => undefined)
    const ok = result !== undefined && result.status >= 200 && result.status < 300
    const models = ok ? deskModels(result.body) : undefined
    if (!models) return undefined
    const read = { models, local: localModels(result!.body) }
    // An empty list is a location still booting; read again next time.
    if (models.length > 0) this.catalog = { at: Date.now(), ...read }
    return read
  }

  /** The daemon's model catalog, reused for MODELS_TTL_MS; undefined when it cannot be read. */
  async models(fresh = false): Promise<DeskModel[] | undefined> {
    return (await this.read(fresh))?.models
  }

  /** `/desk/capabilities` `privacy`: the configured masking model and the local models to pick from. */
  async privacy(): Promise<DeskPrivacy> {
    const [settings, catalog] = await Promise.all([
      this.daemon.raw("GET", "/api/privacy").catch(() => undefined),
      this.read(),
    ])
    const model = (settings?.body as { model?: unknown } | undefined)?.model
    return {
      model: settings && settings.status >= 200 && settings.status < 300 && typeof model === "string" ? model : null,
      localModels: catalog?.local ?? [],
    }
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
      const body =
        typeof request.body === "object" && request.body !== null ? (request.body as Record<string, unknown>) : {}
      if (ref && known)
        return { applied: modelName(ref), body: { ...body, model: { id: ref.id, providerID: ref.providerID } } }
      if (wanted !== DEFAULT_MODEL)
        this.log(`model ${JSON.stringify(wanted.slice(0, 80))} is not on this PC; using its default`)
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
    void appendEvent({
      type: "auto_all_on",
      sessionId: sessionID,
      ...(link.device ? { device: link.device } : {}),
    }).catch((error: unknown) =>
      this.log(`events.jsonl write failed: ${error instanceof Error ? error.message : String(error)}`),
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
    // Skill folders of sessions deleted while the desk was off.
    void this.skills
      .sweep(async (id) => {
        const result = await this.daemon.raw("GET", `/api/session/${encodeURIComponent(id)}`)
        return result.status !== 404
      })
      .catch(() => undefined)
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
    if (event.type === "permission.v2.asked" && typeof event.data?.id === "string") this.asked.add(event.data.id)
    if (event.type === "permission.v2.replied" && typeof event.data?.requestID === "string")
      this.asked.delete(event.data.requestID)
    if (ACTIVITY_EVENTS.has(event.type)) this.onActivity()
    if (
      event.type === "permission.v2.asked" &&
      sessionID &&
      MobileProfile.isMobile(sessionID) &&
      !this.watched(sessionID)
    ) {
      void this.notify("approval", sessionID).catch(() => undefined)
    }
    if (event.type === "session.deleted" && sessionID)
      void this.skills.remove(sessionID).catch((error: unknown) =>
        this.log(`skill folder cleanup failed: ${error instanceof Error ? error.message : String(error)}`),
      )
    // A file changed in a work folder: to the devices working in that folder (the file panel).
    const changed = event.type === WATCHER_EVENT ? watchedFile(event) : undefined
    for (const link of this.links) {
      const wanted =
        permission ||
        LIST_EVENTS.has(event.type) ||
        (sessionID !== undefined && link.subscriptions.has(sessionID)) ||
        (changed !== undefined && [...(link.watching ?? [])].some((root) => within(root, changed)))
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
      else if (event.type === "session.next.tool.input.started" || event.type === "session.next.tool.called")
        this.toolStep.add(sessionID)
      else if (event.type === "session.next.step.failed") this.turnEnded(sessionID, stepError(event.data))
      // Some console models finish a tool step with "stop"/"other"; a step that called a tool is not the end.
      else if (event.type === "session.next.step.ended" && finish !== "tool-calls" && !this.toolStep.has(sessionID))
        this.turnEnded(sessionID)
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
