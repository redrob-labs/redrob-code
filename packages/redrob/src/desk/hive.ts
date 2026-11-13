/**
 * PC schedules (redrob-chat `SchedulesService`, target `hive`). A schedule set to run on one of the
 * person's computers stays `due` on the chat server until that computer takes it; unclaimed for an
 * hour it is missed. The server has no path to the machine, so this machine pulls:
 *
 * every minute while the desk relay runs (signed in, desk on): `GET /schedules/hive/due?machineId=`,
 * claim one (`POST /schedules/runs/:id/claim`; a 409 means it was taken or is no longer due), run
 * its prompt as a new session on this engine (the PC's default model and tools, approval as the web
 * gets it: Auto all on a trusted machine with the launcher's switch on, else edits), wait for the
 * turn to end, and report `POST /schedules/runs/:id/finish` with done or failed and the final text.
 * The server saves that text in the schedule's chat and opens a chat per `<new_chat>` block.
 *
 * A claimed run is written to `~/.redrob/desk/hive.json` before the claim and removed once the
 * server has its finish. What is left there when the engine starts again (it stopped mid-run) is
 * finished as failed, never run a second time; a finish the server did not get is sent again.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { MobileProfile } from "@redrob-code/core/permission/mobile"
import { ChatError, type ChatApi, type HiveFinish, type HiveRun } from "./auth"
import type { DaemonApi } from "./daemon"
import type { Logger } from "./relay"
import { allowAutoAll, deskHome, machine, type Machine } from "./settings"

/** How often due firings are asked for. */
export const EVERY_MS = 60_000
/** The first ask after the relay starts. */
const FIRST_MS = 5_000
/** redrob-chat `FinishHiveRunDto` limits. */
const TEXT_MAX = 400_000
const ERROR_MAX = 2_000
/** How often a running session is looked at. */
const POLL_MS = 2_000
/** Inactive this many looks in a row with no finished answer (the turn never started): failed. */
const SETTLE_TRIES = 30

export const INTERRUPTED =
  "Redrob stopped on this computer before the run finished (the app or the computer restarted)."
export const READ_ONLY = "This computer is set to read only for Redrob Chat, so it runs no schedules."
export const NO_ANSWER = "The run ended without an answer."

export type HiveChat = Pick<ChatApi, "hiveDue" | "hiveClaim" | "hiveFinish">
export type HiveDaemon = Pick<DaemonApi, "raw">

/** One claimed run as kept on disk. `finish` is set once the run ended and the server has not taken it yet. */
type Entry = { readonly at: number; readonly sessionId?: string; readonly finish?: HiveFinish }

/**
 * Runs this process is working on. Module state, not the runner's: the relay (and its runner) is
 * made again when the sign-in changes, and its new runner must not take these for leftovers.
 */
const active = new Set<string>()

export function hivePath(): string {
  return path.join(deskHome(), ".redrob", "desk", "hive.json")
}

async function readEntries(): Promise<Record<string, Entry>> {
  try {
    const value = JSON.parse(await readFile(hivePath(), "utf8")) as { runs?: unknown }
    return typeof value.runs === "object" && value.runs !== null ? (value.runs as Record<string, Entry>) : {}
  } catch {
    return {}
  }
}

let writing: Promise<unknown> = Promise.resolve()

/** Serialized read-change-replace of the whole file. */
function updateEntries(change: (runs: Record<string, Entry>) => void): Promise<void> {
  const run = writing.then(async () => {
    const runs = await readEntries()
    change(runs)
    const file = hivePath()
    await mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify({ runs }, null, 2) + "\n", "utf8")
    await rename(temp, file)
  })
  writing = run.catch(() => undefined)
  return run
}

const setEntry = (id: string, entry: Entry) => updateEntries((runs) => void (runs[id] = entry))
const dropEntry = (id: string) => updateEntries((runs) => void delete runs[id])

/** The server will never take this finish (the run is gone, or no longer running). */
const settled = (error: unknown) => error instanceof ChatError && (error.status === 404 || error.status === 409)

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

type Outcome = { readonly status: "done" | "failed"; readonly text?: string; readonly error?: string }

/**
 * PURE. How a run's session ended, from its context messages (`GET /api/session/:id/context`):
 * the last assistant message's text, failed when it carries an error or no text. Undefined while
 * no assistant message has finished yet.
 */
export function outcome(messages: unknown): Outcome | undefined {
  if (!Array.isArray(messages)) return undefined
  const last = messages
    .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null && m.type === "assistant")
    .at(-1)
  if (!last) return undefined
  const error = (last.error as { message?: unknown } | undefined)?.message
  const completed = (last.time as { completed?: unknown } | undefined)?.completed
  if (completed === undefined && error === undefined) return undefined
  const text = (Array.isArray(last.content) ? last.content : [])
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n\n")
    .trim()
  if (error !== undefined) return { status: "failed", error: String(error), ...(text ? { text } : {}) }
  return text ? { status: "done", text } : { status: "failed", error: NO_ANSWER }
}

function finishBody(machineId: string, out: Outcome): HiveFinish {
  return {
    machineId,
    status: out.status,
    ...(out.error ? { error: out.error.slice(0, ERROR_MAX) } : {}),
    ...(out.text ? { text: out.text.slice(0, TEXT_MAX) } : {}),
  }
}

export class HiveRunner {
  private timers: ReturnType<typeof setTimeout>[] = []
  private ticking = false
  /** Runs started by this runner, for tests and shutdown. */
  readonly running = new Set<Promise<void>>()

  constructor(
    private readonly chat: HiveChat,
    private readonly daemon: HiveDaemon,
    private readonly log: Logger,
    private readonly pollMs = POLL_MS,
  ) {}

  start(): void {
    if (this.timers.length) return
    this.timers.push(
      setTimeout(() => void this.tick(), FIRST_MS),
      setInterval(() => void this.tick(), EVERY_MS),
    )
    for (const timer of this.timers) timer.unref?.()
  }

  /** No new runs. A run already going finishes and reports. */
  stop(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }

  /** One pass: report leftovers, then take at most one due firing. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const self = await machine()
      const left = await this.settle(self.id)
      const due = await this.chat.hiveDue(self.id)
      const next = due.find((run) => !active.has(run.id) && !left.has(run.id))
      if (next) await this.take(next, self)
    } catch (error) {
      this.log.warn(`schedules: ${message(error)}`)
    } finally {
      this.ticking = false
    }
  }

  /** Sends what is left on disk and not running here. Returns the ids still kept after that. */
  private async settle(machineId: string): Promise<Set<string>> {
    const left = new Set<string>()
    for (const [id, entry] of Object.entries(await readEntries())) {
      if (active.has(id)) continue
      const finish = entry.finish ?? finishBody(machineId, { status: "failed", error: INTERRUPTED })
      if (!(await this.report(id, finish))) left.add(id)
    }
    return left
  }

  /** Sends a finish; kept on disk until the server has it. True when nothing is left to send. */
  private async report(id: string, finish: HiveFinish): Promise<boolean> {
    try {
      await this.chat.hiveFinish(id, finish)
    } catch (error) {
      if (!settled(error)) {
        await setEntry(id, { at: Date.now(), finish })
        this.log.warn(`schedules: finishing run ${id} failed, will retry: ${message(error)}`)
        return false
      }
    }
    await dropEntry(id)
    return true
  }

  /** Claims a firing and starts it. Written to disk first, so a stop between the claim and the run is reported. */
  private async take(run: HiveRun, self: Machine): Promise<void> {
    await setEntry(run.id, { at: Date.now() })
    active.add(run.id)
    let claimed: HiveRun
    try {
      claimed = await this.chat.hiveClaim(run.id, self.id)
    } catch (error) {
      active.delete(run.id)
      // Not ours (taken or no longer due): forget it. Anything else: the claim may have landed,
      // so the entry stays and the next pass finishes it as failed (a 409 there drops it).
      if (settled(error)) await dropEntry(run.id)
      throw error
    }
    this.log.info(`schedules: running ${run.id}`)
    const going = this.run(claimed, self).finally(() => {
      active.delete(run.id)
      this.running.delete(going)
    })
    this.running.add(going)
  }

  private async run(run: HiveRun, self: Machine): Promise<void> {
    let out: Outcome
    try {
      out = self.access === "read_only" ? { status: "failed", error: READ_ONLY } : await this.execute(run, self)
    } catch (error) {
      out = { status: "failed", error: message(error) }
    }
    await this.report(run.id, finishBody(self.id, out))
    this.log.info(`schedules: run ${run.id} ${out.status}`)
  }

  /** A new session with the run's prompt, followed to the end of its turn. */
  private async execute(run: HiveRun, self: Machine): Promise<Outcome> {
    const created = await this.daemon.raw("POST", "/api/session", {})
    const sessionId = (created.body as { data?: { id?: unknown } } | undefined)?.data?.id
    if (created.status >= 300 || typeof sessionId !== "string")
      throw new Error(`could not start a session on this computer (${created.status})`)
    await setEntry(run.id, { at: Date.now(), sessionId })
    // Nobody is at the screen: the web's approval rules, as for a chat sent from the web.
    MobileProfile.mark(sessionId, self.access === "trusted" && (await allowAutoAll()) ? "all" : "edits")
    const sent = await this.daemon.raw("POST", `/api/session/${sessionId}/prompt`, { prompt: { text: run.prompt } })
    if (sent.status >= 300) throw new Error(`could not send the prompt (${sent.status})`)
    // `POST /api/session/:id/wait` answers 503 on V2 sessions (forward.ts watchTurn), so the turn is
    // followed by polling: over once the session is no longer active and its last answer is complete.
    let idle = 0
    while (idle < SETTLE_TRIES) {
      await Bun.sleep(this.pollMs)
      const active = await this.daemon.raw("GET", "/api/session/active")
      const running = (active.body as { data?: Record<string, unknown> } | undefined)?.data?.[sessionId] !== undefined
      if (running) {
        idle = 0
        continue
      }
      const context = await this.daemon.raw("GET", `/api/session/${sessionId}/context`)
      const out = outcome((context.body as { data?: unknown } | undefined)?.data)
      if (out) return out
      idle += 1
    }
    return { status: "failed", error: NO_ANSWER }
  }
}
