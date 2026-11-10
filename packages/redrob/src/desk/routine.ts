/**
 * Routines and work snapshots for a paired device (code-work contract, sections 2.2 and 3).
 *
 * `GET /desk/routine` lists this machine's routines (schedules and watches) with a `wait` record
 * for each watch, the data the web's wait block draws: `{ what, every, state, stopId }`.
 * `POST /desk/routine/:id/stop` stops one for good. The same `wait` record rides on a
 * `routine.wait` event whenever a routine changes, so an open wait block follows it live.
 *
 * `POST /desk/snapshot/:sessionId/revert` puts the files back as they were before the session's
 * work (or before one turn, `{ messageID }`), from the snapshots the engine takes around every
 * step; it works in a folder with no git repository too. `.../unrevert` undoes that.
 */
import { RoutineWatch } from "@/routine/watch"
import type { DaemonApi } from "./daemon"

/** What the wait block shows: the routine is still waiting, paused, or ended (and why). */
export type WaitState = "waiting" | "paused" | "done" | "blocked" | "stopped"

/** Contract 3 `wait` block data. `stopId` is the routine id `POST /desk/routine/:id/stop` takes. */
export type Wait = {
  readonly what: string
  /** Seconds between polls. */
  readonly every: number
  readonly state: WaitState
  readonly stopId: string
  readonly kind: "github_pr" | "ci_run" | "url" | "command"
  readonly url?: string
  readonly reason?: string
}

/** One `GET /desk/routine` entry: the engine's routine, plus `wait` for a watch. */
export type DeskRoutine = {
  readonly id: string
  readonly sessionID: string
  readonly goal: string
  readonly status: string
  readonly trigger: Record<string, unknown>
  readonly cycles: number
  readonly maxCycles: number
  readonly reason?: string
  readonly time: { readonly created: number; readonly updated: number }
  /** Engine routines run on this machine, so they wait for it while it is off (design 17.1). */
  readonly where: "pc"
  readonly wait?: Wait
}

const STATES: Record<string, WaitState> = {
  running: "waiting",
  paused: "paused",
  done: "done",
  blocked: "blocked",
  stopped: "stopped",
}

const DEFAULT_INTERVAL = 300

/** PURE. A routine as the daemon's `/routine` routes return it, as the desk view; undefined when malformed. */
export function deskRoutine(value: unknown): DeskRoutine | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const info = value as Record<string, unknown>
  const trigger = info.trigger as Record<string, unknown> | undefined
  const time = info.time as { created?: unknown; updated?: unknown } | undefined
  if (
    typeof info.id !== "string" ||
    typeof info.sessionID !== "string" ||
    typeof info.goal !== "string" ||
    typeof info.status !== "string" ||
    typeof trigger?.type !== "string" ||
    typeof time?.created !== "number" ||
    typeof time.updated !== "number"
  )
    return undefined
  const reason = typeof info.reason === "string" ? info.reason : undefined
  return {
    id: info.id,
    sessionID: info.sessionID,
    goal: info.goal,
    status: info.status,
    trigger,
    cycles: typeof info.cycles === "number" ? info.cycles : 0,
    maxCycles: typeof info.maxCycles === "number" ? info.maxCycles : 0,
    ...(reason ? { reason } : {}),
    time: { created: time.created, updated: time.updated },
    where: "pc",
    ...(trigger.type === "watch" ? { wait: waitOf(info.id, info.status, trigger, reason) } : {}),
  }
}

function waitOf(id: string, status: string, trigger: Record<string, unknown>, reason: string | undefined): Wait | undefined {
  const target = RoutineWatch.subject({
    kind: String(trigger.kind ?? "github_pr"),
    ...(typeof trigger.url === "string" ? { url: trigger.url } : {}),
    ...(typeof trigger.command === "string" ? { command: trigger.command } : {}),
  })
  if (typeof target === "string") return undefined
  return {
    what: RoutineWatch.label(target),
    every: typeof trigger.interval === "number" ? trigger.interval : DEFAULT_INTERVAL,
    state: STATES[status] ?? "stopped",
    stopId: id,
    kind: target.kind,
    ...(target.kind !== "command" ? { url: target.url } : {}),
    ...(reason && status !== "running" ? { reason } : {}),
  }
}

const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,124}$/

/** `?sessionID=` of a `GET /desk/routine` path: undefined for none, null when malformed. */
export function sessionFilter(path: string): string | undefined | null {
  const mark = path.indexOf("?")
  if (mark < 0) return undefined
  const query = new URLSearchParams(path.slice(mark + 1))
  for (const key of query.keys()) if (key !== "sessionID") return null
  const value = query.get("sessionID")
  if (value === null) return undefined
  return SESSION_ID.test(value) ? value : null
}

type Reply = { status: number; body?: unknown }

/** `GET /desk/routine[?sessionID=]`. */
export async function listRoutines(daemon: DaemonApi, path: string): Promise<Reply> {
  const sessionID = sessionFilter(path)
  if (sessionID === null) return { status: 400 }
  const result = await daemon.raw("GET", `/routine${sessionID ? `?sessionID=${sessionID}` : ""}`)
  if (result.status < 200 || result.status >= 300 || !Array.isArray(result.body)) return { status: result.status >= 400 ? result.status : 502 }
  const routines = result.body.flatMap((item) => {
    const routine = deskRoutine(item)
    return routine ? [routine] : []
  })
  return { status: 200, body: { v: 1, routines } }
}

/** `POST /desk/routine/:id/stop`. */
export async function stopRoutine(daemon: DaemonApi, id: string): Promise<Reply> {
  if (!id.startsWith("rtn")) return { status: 404 }
  const result = await daemon.raw("POST", `/routine/${id}/stop`)
  if (result.status < 200 || result.status >= 300) return { status: result.status }
  const routine = deskRoutine(result.body)
  return routine ? { status: 200, body: { v: 1, routine } } : { status: 502 }
}

/** The bus event a routine change becomes for paired devices; undefined for anything else. */
export function routineEvent(data: Record<string, unknown> | undefined): { type: "routine.wait"; data: Record<string, unknown> } | undefined {
  const routine = deskRoutine(data?.info)
  if (!routine) return undefined
  return { type: "routine.wait", data: { sessionID: routine.sessionID, routine } }
}

const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/
const HISTORY_PAGE = 100
const HISTORY_PAGES = 50

/** `{ messageID? }`: the body `POST /desk/snapshot/:id/revert` takes. */
export function isRevertBody(body: unknown): boolean {
  if (body === undefined || body === null) return true
  if (typeof body !== "object" || Array.isArray(body)) return false
  const { messageID, ...rest } = body as { messageID?: unknown }
  if (Object.keys(rest).length > 0) return false
  return messageID === undefined || (typeof messageID === "string" && MESSAGE_ID.test(messageID))
}

/** The session's first prompt, read off its durable history; undefined when it has none. */
async function firstPrompt(daemon: DaemonApi, sessionID: string): Promise<string | undefined | Reply> {
  let after: number | undefined
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const query = `limit=${HISTORY_PAGE}${after !== undefined ? `&after=${after}` : ""}`
    const result = await daemon.raw("GET", `/api/session/${sessionID}/history?${query}`)
    if (result.status < 200 || result.status >= 300) return { status: result.status }
    const body = result.body as { data?: unknown; hasMore?: unknown } | undefined
    const events = Array.isArray(body?.data) ? (body.data as Record<string, unknown>[]) : []
    for (const event of events) {
      const data = event.data as { messageID?: unknown } | undefined
      if (
        (event.type === "session.next.prompt.admitted" || event.type === "session.next.prompted") &&
        typeof data?.messageID === "string"
      )
        return data.messageID
    }
    const last = events.at(-1)?.durable as { seq?: unknown } | undefined
    if (body?.hasMore !== true || typeof last?.seq !== "number") return undefined
    after = last.seq
  }
  return undefined
}

type RevertFile = { path: string; status: string; additions: number; deletions: number }

/** `POST /desk/snapshot/:sessionId/revert`: the files back as before the work (or before `messageID`). */
export async function revertWork(daemon: DaemonApi, sessionID: string, body: unknown): Promise<Reply> {
  const wanted = (body as { messageID?: string } | undefined)?.messageID
  const messageID = wanted ?? (await firstPrompt(daemon, sessionID))
  if (messageID === undefined) return { status: 404, body: { message: "This session has no work to put back." } }
  if (typeof messageID !== "string") return messageID
  const result = await daemon.raw("POST", `/api/session/${sessionID}/revert/stage`, { messageID }, 120_000)
  if (result.status < 200 || result.status >= 300) return { status: result.status, ...(result.body !== undefined ? { body: result.body } : {}) }
  const state = (result.body as { data?: { messageID?: unknown; files?: unknown } } | undefined)?.data
  const files: RevertFile[] = Array.isArray(state?.files)
    ? (state.files as Record<string, unknown>[]).flatMap((file) =>
        typeof file.path === "string"
          ? [
              {
                path: file.path,
                status: typeof file.status === "string" ? file.status : "modified",
                additions: typeof file.additions === "number" ? file.additions : 0,
                deletions: typeof file.deletions === "number" ? file.deletions : 0,
              },
            ]
          : [],
      )
    : []
  return { status: 200, body: { v: 1, sessionID, messageID, files } }
}

/** `POST /desk/snapshot/:sessionId/unrevert`: undo a revert that has not been built on yet. */
export async function unrevertWork(daemon: DaemonApi, sessionID: string): Promise<Reply> {
  const result = await daemon.raw("POST", `/api/session/${sessionID}/revert/clear`, undefined, 120_000)
  if (result.status < 200 || result.status >= 300) return { status: result.status }
  return { status: 200, body: { v: 1, sessionID } }
}
