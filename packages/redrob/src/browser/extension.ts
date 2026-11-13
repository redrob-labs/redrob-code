/**
 * The `browser` tool in the person's own Chrome, through the Redrob extension.
 *
 * The extension takes tasks, not clicks: its own agent drives the page (redrob-extension AGENTS.md,
 * "Nothing outside the extension calls the layer directly"), and every caller uses the same route
 * set (`POST /browser/task`, `GET /browser/task/:id`, docs/remote-control.md). So each action of
 * the tool becomes one short, exact task in the same conversation and tab (`followUp`), and the
 * extension answers with a reading in the tool's own shape: URL, title, text and numbered elements.
 * Approvals, payments and sign-ins stay the person's step in Chrome, at the level they chose there.
 *
 * The daemon holds the relay link (desk/extension.ts). An engine that is the daemon asks it
 * directly; any other engine on this machine (`redrob run`, the terminal app) asks it with
 * `POST /desk/browser`. With no daemon, no relay, no browser, or no Allow, `act` returns a fallback
 * reason and the tool uses its own Chromium as before.
 */
import * as Channels from "@redrob-code/server/channels"
import * as Registry from "@/daemon/registry"

export type Action = "open" | "read" | "click" | "type" | "scroll" | "wait" | "screenshot"

export type Input = {
  readonly action: Action
  readonly url?: string
  readonly ref?: string
  readonly text?: string
  readonly submit?: boolean
  readonly direction?: "down" | "up"
  readonly amount?: number
  readonly seconds?: number
}

export type Ask = (request: Channels.DeskBrowserRequest, signal?: AbortSignal) => Promise<Channels.DeskBrowserResponse>

export type Result =
  | { readonly kind: "extension"; readonly browser: string; readonly url: string; readonly text: string }
  | { readonly kind: "fallback"; readonly reason: string }

const POLL_MS = 1_000
/** A task waits at most this long, as long as a hand-over to the person may last. */
const TASK_MS = 10 * 60_000
const TERMINAL = new Set(["done", "failed", "stopped", "capped"])

/** How the reply is asked for, so the model reads the same shape as from its own Chromium. */
export const READING = [
  "Then reply with only a reading of the page as it is now, in exactly this form and nothing else:",
  "URL: <address>",
  "Title: <title>",
  "",
  "<the page's visible text, up to about 3000 characters>",
  "",
  "Elements:",
  "[e1] <role> «<text>»",
  "One line per link, button and field on the page you could act on, numbered e1, e2, … in page order (at most 60).",
  "Do nothing else on the page: no other clicks, typing or submitting.",
].join("\n")

type Session = {
  /** The last task, so the next action goes on in its conversation and tab. */
  task?: string
  /** The element lines of the last reading, by ref, so a click names what it clicks. */
  elements: Map<string, string>
  /** The browser this session last used; a session stays in it until the next `open`. */
  used?: "extension" | "chromium"
}

const sessions = new Map<string, Session>()

function session(id: string): Session {
  let state = sessions.get(id)
  if (!state) {
    state = { elements: new Map() }
    sessions.set(id, state)
    if (sessions.size > 200) sessions.delete(sessions.keys().next().value!)
  }
  return state
}

/** The chat id the extension keys follow-ups on: one per Code session, in its id shape. */
export function chatId(sessionID: string): string {
  return `code-${sessionID}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128)
}

/** `[e5] button «Send»` from a reading's Elements list, or just the ref when it is not there. */
function label(state: Session, ref: string): string {
  const line = state.elements.get(ref.replace(/^\[|\]$/g, ""))
  return line ? `[${ref}] ${line}` : `[${ref}]`
}

/** The task one action becomes. Undefined for an action the extension cannot do (screenshot). */
export function task(input: Input, state: Session): string | undefined {
  const quote = (text: string) => `«${text.replace(/»/g, "”")}»`
  switch (input.action) {
    case "open":
      return `Open ${input.url} in this tab.\n${READING}`
    case "read":
      return `Read the page in this tab again.\n${READING}`
    case "click":
      return `Click ${label(state, input.ref ?? "")} from your last reading, once.\n${READING}`
    case "type":
      return [
        `Type exactly this text into the field ${label(state, input.ref ?? "")} from your last reading, replacing what is in it: ${quote(input.text ?? "")}.`,
        input.submit ? "Then press Enter once." : "Do not press Enter.",
        READING,
      ].join("\n")
    case "scroll":
      return input.ref
        ? `Scroll ${label(state, input.ref)} from your last reading into view.\n${READING}`
        : `Scroll the page ${input.direction ?? "down"} by about ${input.amount ?? 600} pixels.\n${READING}`
    case "wait":
      return input.text
        ? `Wait until the text ${quote(input.text)} is visible in this tab, at most ${Math.min(input.seconds ?? 30, 60)} seconds.\n${READING}`
        : `Read the page in this tab again.\n${READING}`
    case "screenshot":
      return undefined
  }
}

/** The element lines of a reading, by ref. */
export function elements(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split("\n")) {
    const found = /^\s*\[(e\d+)\]\s*(.+?)\s*$/.exec(line)
    if (found) out.set(found[1]!, found[2]!)
  }
  return out
}

type TaskEvent = { n: number; kind: string; text?: string; tool?: string; url?: string; question?: string; site?: string }
type TaskView = { id: string; state: string; events: TaskEvent[]; answer?: string; error?: string }

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true })
  })

/**
 * Runs one action in the person's Chrome. A `fallback` result means it never reached the extension
 * (the tool uses its own Chromium and says why); anything that went wrong after that throws.
 */
export async function act(
  input: Input,
  context: { readonly sessionID: string; readonly signal?: AbortSignal; readonly ask?: Ask },
): Promise<Result> {
  const result = await attempt(input, context)
  if (result.kind === "fallback") session(context.sessionID).used = "chromium"
  return result
}

async function attempt(
  input: Input,
  context: { readonly sessionID: string; readonly signal?: AbortSignal; readonly ask?: Ask },
): Promise<Result> {
  const state = session(context.sessionID)
  if (input.action !== "open" && state.used === "chromium") return { kind: "fallback", reason: "" }
  const ask = context.ask ?? (await asker())
  if (!ask) return { kind: "fallback", reason: "no Redrob engine service is running on this computer" }
  const text = task(input, state)
  if (text === undefined) {
    if (state.used !== "extension") return { kind: "fallback", reason: "" }
    throw new Error(
      "A screenshot of the person's own Chrome is not available through the Redrob extension. Use `read` for the page as text.",
    )
  }
  if (input.action === "wait" && !input.text && input.seconds) await sleep(Math.min(input.seconds, 60) * 1000, context.signal)

  // The same Code session goes on in the same conversation and tab, also after an engine restart.
  const chat = chatId(context.sessionID)
  if (!state.task) {
    const found = await ask({ method: "GET", path: `/browser/task?chatId=${chat}` }, context.signal).catch(() => undefined)
    const id = (found?.body as { id?: unknown } | undefined)?.id
    if (found?.status === 200 && typeof id === "string") state.task = id
  }
  const created = await ask(
    {
      method: "POST",
      path: "/browser/task",
      body: { task: text, origin: "code", chatId: chat, ...(state.task ? { followUp: state.task } : {}) },
    },
    context.signal,
  )
  const id = (created.body as { id?: unknown } | undefined)?.id
  if (created.status !== 200 || typeof id !== "string") {
    if (created.status === 0 || created.status === 503) {
      return { kind: "fallback", reason: created.error ?? `the extension is not ready (${created.browser.state})` }
    }
    throw new Error(`The Redrob extension refused the task (HTTP ${created.status}).`)
  }
  state.used = "extension"
  state.task = id
  const browser = created.browser.name ?? "Chrome"
  const view = await follow(ask, id, context.signal)
  const answer = view.answer?.trim() ?? ""
  if (view.state === "failed") throw new Error(`${browser}: ${view.error ?? "the task failed"}`)
  if (view.state === "stopped" && !answer) throw new Error(`${browser}: the task was stopped`)
  const asked = view.events.findLast((event) => event.kind === "approval_needed" && event.tool === "ask-input")
  const body = answer || (asked?.question ? `The browser's agent asks: ${asked.question}` : "(no reading came back)")
  const found = elements(body)
  if (found.size > 0) state.elements = found
  const url =
    /^URL:\s*(\S+)/m.exec(body)?.[1] ?? view.events.findLast((event) => typeof event.url === "string")?.url ?? input.url ?? ""
  return { kind: "extension", browser, url, text: body }
}

/** Polls the task until it ends. A question for the person ends it too: the model reads it in the result. */
async function follow(ask: Ask, id: string, signal?: AbortSignal): Promise<TaskView> {
  const events: TaskEvent[] = []
  let after = -1
  const end = Date.now() + TASK_MS
  const stop = () => ask({ method: "POST", path: `/browser/task/${id}/stop` }).catch(() => undefined)
  while (true) {
    if (signal?.aborted) {
      await stop()
      throw new Error("aborted")
    }
    const response = await ask({ method: "GET", path: `/browser/task/${id}?after=${after}` }, signal)
    if (response.status !== 200) throw new Error(`The Redrob extension lost the task (HTTP ${response.status}).`)
    const view = response.body as TaskView
    for (const event of view.events ?? []) {
      events.push(event)
      after = Math.max(after, event.n)
    }
    const question = view.state === "waiting_approval" && events.at(-1)?.kind === "approval_needed" && events.at(-1)?.tool === "ask-input"
    if (question) await stop()
    if (TERMINAL.has(view.state) || question) return { ...view, events }
    if (Date.now() > end) {
      await stop()
      throw new Error("The task in the person's Chrome took longer than 10 minutes and was stopped.")
    }
    await sleep(POLL_MS, signal)
  }
}

/** The daemon's relay link: in this process when it is the daemon, else over its local API. */
export async function asker(env: NodeJS.ProcessEnv = process.env): Promise<Ask | undefined> {
  const local = Channels.current()?.desk
  if (local?.browser) return (request) => local.browser!(request)
  const record = await Registry.read(env).catch(() => undefined)
  if (!record || !Registry.alive(record.pid)) return undefined
  return async (request, signal) => {
    const response = await fetch(`${record.url}/desk/browser`, {
      method: "POST",
      headers: { ...Registry.headers(record.secret), "Content-Type": "application/json" },
      body: JSON.stringify(request),
      // The first request may wait two minutes for Allow in Chrome.
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
    }).catch((error: unknown) => ({ ok: false, status: 0, error }) as const)
    // An older daemon has no such route (404), a server that is not the daemon has no desk (503).
    if (!("json" in response) || !response.ok) {
      return { status: 0, browser: { state: "off" }, error: `the engine service has no browser link (HTTP ${response.status})` }
    }
    return (await response.json()) as Channels.DeskBrowserResponse
  }
}

/** Whether the person's browser may be reachable at all, so the tool is offered without a Chromium. */
export async function reachable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (Channels.current()?.desk?.browser) return true
  const record = await Registry.read(env).catch(() => undefined)
  return !!record && Registry.alive(record.pid)
}

/** The first line of every result: which browser the action ran in, and why not the person's own. */
export function line(result: Result): string {
  if (result.kind === "extension") return `Browser: the person's own Chrome (${result.browser}), through the Redrob extension.`
  return `Browser: Redrob Code's own Chromium on this machine (headless).${result.reason ? ` The person's Chrome is not used: ${result.reason}.` : ""}`
}

/** Forget a session's state (tests). */
export function reset(): void {
  sessions.clear()
}

export * as UserBrowser from "./extension"
