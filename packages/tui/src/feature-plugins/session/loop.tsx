import type { TuiPlugin, TuiPluginApi } from "@redrob-code/plugin/tui"

import type { BuiltinTuiPlugin } from "../builtins"
import { kvTranslator } from "../../i18n"

const id = "internal:loop"

/**
 * Autopilot: hold a GOAL and keep nudging toward it, one turn at a time, until it is met.
 *
 * The distinction that matters, and that the first version of this file got wrong: an autopilot does not
 * re-send a fixed instruction. Re-sending the same sentence gives the model the same input every cycle,
 * so it has no way to notice it is going in circles and no reason to change approach. What makes a loop
 * useful is that each cycle knows the GOAL and knows WHAT HAS ALREADY BEEN TRIED.
 *
 * So each cycle sends three things: the goal, a ledger of approaches already rejected, and a request to
 * assess where the work stands before taking the next step. The ledger is the part that earns its keep --
 * without it cycle N+1 walks into the wall cycle N just hit, and the loop's cost grows while its progress
 * does not.
 *
 * TERMINAL ONLY. This is session control, not a product capability: nothing reaches the console, the loop
 * itself spends no credit, and there is no API for it. Every cycle is an ORDINARY prompt, so it costs what
 * typing the same thing would have cost and appears in usage as exactly that.
 */

/** A backstop, not a target. A loop that reaches this did not finish; it ran out of rope. */
const DEFAULT_MAX_CYCLES = 25

/**
 * How many identical next-steps in a row count as stuck.
 *
 * Two is too eager -- a model legitimately repeats a step while waiting for something external, like a
 * build. Three consecutive identical plans is not patience, it is a loop with no exit.
 */
const STALL_THRESHOLD = 3

/**
 * What the model is asked to emit, and what this plugin reads back.
 *
 * Exact strings, because they are a contract between the prompt text and the parser. A model asked to
 * "say when it is done" has no way to signal that in a form code can read, so it is given the words.
 */
export const LOOP_MARKERS = {
  /** The goal is met. Requires the model to say HOW it knows, which is the next marker. */
  done: "AUTOPILOT: GOAL MET",
  /** The model cannot proceed without a person -- a decision, a credential, an access it lacks. */
  blocked: "AUTOPILOT: BLOCKED",
  /** Prefix for the one-line plan for this cycle. Repeated verbatim is what stall detection reads. */
  next: "AUTOPILOT NEXT:",
  /** Prefix for an approach that failed, carried into later cycles so they do not retry it. */
  rejected: "AUTOPILOT REJECTED:",
} as const

export type LoopLedger = {
  /** The binding objective. Fixed for the life of the loop; the per-cycle instruction is derived from it. */
  goal: string
  /** One line per approach the model reported as failed, so later cycles do not re-walk them. */
  rejected: string[]
  /** The most recent plans, newest last. Only used to notice repetition. */
  recentNext: string[]
}

type LoopState = {
  sessionID: string
  ledger: LoopLedger
  cycles: number
  maxCycles: number
  /** Set while a cycle's prompt is in flight, so one completion cannot start two cycles. */
  sending: boolean
  /** Accumulates this cycle's assistant text, which arrives in fragments. */
  buffer: string
}

/**
 * Whether the recent plans show the loop going in circles.
 *
 * Compared after normalising whitespace and case, because "Run the tests" and "run the tests." are the
 * same plan and a loop that only notices byte-identical repetition notices nothing.
 */
export function isStalled(recentNext: readonly string[], threshold = STALL_THRESHOLD): boolean {
  if (recentNext.length < threshold) return false
  const tail = recentNext.slice(-threshold).map(line => line.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/, ""))
  return tail.every(line => line.length > 0 && line === tail[0])
}

/** Pull the markers out of a cycle's reply. Tolerant of surrounding prose -- models add it. */
export function readMarkers(text: string): {
  done: boolean
  blocked: boolean
  next: string | undefined
  rejected: string[]
} {
  const lines = text.split("\n").map(line => line.trim())
  const after = (prefix: string) =>
    lines.filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length).trim())
  const nextLines = after(LOOP_MARKERS.next)
  return {
    done: text.includes(LOOP_MARKERS.done),
    blocked: text.includes(LOOP_MARKERS.blocked),
    /* The LAST plan wins: a model that revises mid-reply meant the revision. */
    next: nextLines.length > 0 ? nextLines[nextLines.length - 1] : undefined,
    rejected: after(LOOP_MARKERS.rejected).filter(line => line.length > 0),
  }
}

/**
 * The prompt for one cycle.
 *
 * Built fresh every time rather than stored, because its whole point is to carry state that has changed:
 * the rejected list grows, and the cycle number moves. A stored instruction cannot do that.
 */
export function cyclePrompt(ledger: LoopLedger, cycle: number, maxCycles: number): string {
  const parts: string[] = [
    `You are on autopilot. This is cycle ${cycle} of at most ${maxCycles}.`,
    "",
    "GOAL",
    ledger.goal,
  ]

  if (ledger.rejected.length > 0) {
    parts.push(
      "",
      "ALREADY TRIED AND REJECTED -- do not repeat these:",
      ...ledger.rejected.map(item => `- ${item}`),
    )
  }

  parts.push(
    "",
    "Assess where the work stands against the GOAL, then take the single next step. Do the work; do not",
    "just describe it.",
    "",
    "End your reply with these lines:",
    `  ${LOOP_MARKERS.next} <the one concrete step you will take next>`,
    `  ${LOOP_MARKERS.rejected} <an approach you just ruled out>   (only if you ruled one out)`,
    "",
    `When the GOAL is met, say ${LOOP_MARKERS.done} and state how you verified it.`,
    `If you cannot proceed without a person -- a decision, a credential, an access you lack -- say`,
    `${LOOP_MARKERS.blocked} and say what you need. Do not guess at it and do not keep trying.`,
  )

  return parts.join("\n")
}


/**
 * Where a loop's ledger is kept between runs.
 *
 * Through `api.kv`, which is already written atomically under a lock to `paths.state/kv.json` -- so this
 * needs no file handling of its own, and cannot race the rest of the TUI's persisted state.
 *
 * WHAT THIS ACTUALLY BUYS, stated precisely because it is easy to overclaim: the ledger lives in plugin
 * memory, which context compaction does not touch, and `cyclePrompt` re-sends the rejected list every
 * cycle, so the model already recovers it after a compaction. What is NOT survivable without this is the
 * CLI exiting -- a crash, a restart, closing the terminal -- which today loses every approach the loop
 * learned was a dead end. Restoring it means a resumed loop does not re-walk them.
 */
const LEDGER_KEY_PREFIX = "loop.ledger."

function ledgerKey(sessionID: string): string {
  return `${LEDGER_KEY_PREFIX}${sessionID}`
}

function saveLedger(api: TuiPluginApi, sessionID: string, ledger: LoopLedger): void {
  api.kv.set(ledgerKey(sessionID), ledger)
}

function clearLedger(api: TuiPluginApi, sessionID: string): void {
  /* Cleared rather than left behind: a finished goal's dead ends are not advice for the next goal. */
  api.kv.set(ledgerKey(sessionID), undefined)
}

/**
 * Read a stored ledger back, defensively.
 *
 * Anything on disk is untrusted input -- an older build wrote a different shape, a hand-edited file, a
 * truncated write. A malformed ledger is treated as absent rather than crashing the loop or, worse,
 * feeding the model a half-read list of things it must not retry.
 */
export function parseLedger(value: unknown): LoopLedger | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.goal !== "string" || record.goal.trim().length === 0) return undefined
  const strings = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : []
  return {
    goal: record.goal,
    rejected: strings(record.rejected),
    recentNext: strings(record.recentNext),
  }
}

/**
 * The session the user is looking at, read from the route rather than from a "current session" accessor,
 * because the plugin state exposes sessions by id and has no notion of which one is on screen.
 */
function activeSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  if (route.name !== "session") return undefined
  const sessionID = route.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

const tui: TuiPlugin = async (api) => {
  /*
    One loop per session. Sessions are independent conversations, and autopilot is a property of the thing
    being driven -- running one goal in one session while asking a question in another is ordinary.
  */
  const loops = new Map<string, LoopState>()

  const stop = (sessionID: string, reason: string, variant: "info" | "error" = "info") => {
    const state = loops.get(sessionID)
    if (!state) return false
    loops.delete(sessionID)
    clearLedger(api, sessionID)
    api.ui.toast({
      title: kvTranslator(api.kv).t("loop.stopped.title"),
      message: reason,
      variant,
    })
    return true
  }

  const send = async (state: LoopState) => {
    state.sending = true
    state.buffer = ""
    const text = cyclePrompt(state.ledger, state.cycles + 1, state.maxCycles)
    try {
      await api.client.session.prompt(
        { sessionID: state.sessionID, parts: [{ type: "text", text }] },
        { throwOnError: true },
      )
      state.cycles += 1
    } catch (error) {
      /*
        A failed send ends the loop rather than retrying. The turn that would carry the work never started,
        so retrying blind re-sends into a session whose state this plugin cannot see -- and a loop that
        stops visibly is easier to recover from than one that silently doubles up.
      */
      loops.delete(state.sessionID)
      api.ui.toast({
        title: kvTranslator(api.kv).t("loop.failed.title"),
        message: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    } finally {
      state.sending = false
    }
  }

  /* Collect the reply as it streams, so the markers can be read once the turn is complete. */
  api.event.on("message.part.updated", (event) => {
    const part = event.properties.part
    if (part.type !== "text") return
    const sessionID = event.properties.sessionID ?? part.sessionID
    if (typeof sessionID !== "string") return
    const state = loops.get(sessionID)
    if (!state || typeof part.text !== "string") return
    state.buffer = part.text
  })

  /*
    `session.idle` is the completion signal: the turn is over and the model has produced the thing the next
    cycle must react to. A timer would fire into a session still working, stacking turns on top of each
    other -- expensive, and useless because the input the next cycle needs does not exist yet.
  */
  api.event.on("session.idle", (event) => {
    const sessionID = event.properties.sessionID
    const state = loops.get(sessionID)
    if (!state || state.sending) return

    const t = kvTranslator(api.kv)
    const markers = readMarkers(state.buffer)

    if (markers.done) {
      stop(sessionID, t.t("loop.stopped.done"))
      return
    }

    if (markers.blocked) {
      /*
        Stopping on BLOCKED is the point of having the marker. A loop that keeps prompting a model which has
        said it needs a human decision burns cycles to re-learn the same thing, and buries the one message
        the person actually needed to read.
      */
      stop(sessionID, t.t("loop.stopped.blocked"))
      return
    }

    /* The ledger grows before the stall check, so a rejection recorded this cycle informs the next one. */
    let ledgerChanged = false
    for (const item of markers.rejected) {
      if (!state.ledger.rejected.includes(item)) {
        state.ledger.rejected.push(item)
        ledgerChanged = true
      }
    }
    if (markers.next) {
      state.ledger.recentNext.push(markers.next)
      ledgerChanged = true
    }
    /* Written after each cycle, not only at the end: the cycle that crashes is the one worth remembering. */
    if (ledgerChanged) saveLedger(api, sessionID, state.ledger)

    if (isStalled(state.ledger.recentNext)) {
      /*
        Repeating one plan is how a loop looks when it has run out of ideas. Stopping hands it back to a
        person while the transcript still shows what it kept trying, which is the useful moment to look.
      */
      stop(sessionID, t.t("loop.stopped.stalled", { step: state.ledger.recentNext.at(-1) ?? "" }))
      return
    }

    if (state.cycles >= state.maxCycles) {
      stop(sessionID, t.t("loop.stopped.exhausted", { max: String(state.maxCycles) }))
      return
    }

    void send(state)
  })

  /* A session that goes away takes its loop with it, so nothing points at a dead conversation. */
  api.event.on("session.deleted", (event) => {
    loops.delete(event.properties.info.id)
  })

  api.event.on("session.error", (event) => {
    const sessionID = event.properties.sessionID
    if (typeof sessionID !== "string") return
    /*
      An error ends the loop. Whatever failed will keep failing, and re-prompting turns one visible error
      into a stream of them.
    */
    if (loops.has(sessionID)) stop(sessionID, kvTranslator(api.kv).t("loop.stopped.error"), "error")
  })

  api.keymap.registerLayer({
    commands: [
      {
        name: "loop.start",
        get title() {
          return kvTranslator(api.kv).t("loop.start.title")
        },
        category: "Session",
        namespace: "palette",
        run() {
          const t = kvTranslator(api.kv)
          const sessionID = activeSessionID(api)
          if (!sessionID) {
            api.ui.toast({
              title: t.t("loop.needs_session.title"),
              message: t.t("loop.needs_session.message"),
              variant: "error",
            })
            return
          }

          const existing = loops.get(sessionID)
          if (existing) {
            api.ui.toast({
              title: t.t("loop.already.title"),
              message: t.t("loop.status", {
                cycle: String(existing.cycles),
                max: String(existing.maxCycles),
              }),
              variant: "info",
            })
            return
          }

          /*
            A ledger left by a previous run means the CLI exited mid-goal. Its goal is offered back as the
            prefilled value so resuming is one keypress, while still being a deliberate choice -- silently
            restarting a loop the user may have abandoned is not a favour.
          */
          const stored = parseLedger(api.kv.get(ledgerKey(sessionID)))

          api.ui.dialog.replace(() => (
            <api.ui.DialogPrompt
              title={t.t("loop.start.title")}
              value={stored?.goal}
              placeholder={t.t("loop.start.placeholder")}
              onConfirm={(value: string) => {
                const goal = value.trim()
                api.ui.dialog.clear()
                if (!goal) return

                /*
                  The rejected list is carried over only when the goal is UNCHANGED. A different goal makes
                  the old dead ends irrelevant at best and misleading at worst -- they were dead ends for a
                  different question.
                */
                const resumed = stored && stored.goal === goal ? stored : undefined
                const state: LoopState = {
                  sessionID,
                  ledger: {
                    goal,
                    rejected: resumed ? [...resumed.rejected] : [],
                    /* Plans are NOT carried over: a stall is about one run's circling, not a resumed run's. */
                    recentNext: [],
                  },
                  cycles: 0,
                  maxCycles: DEFAULT_MAX_CYCLES,
                  sending: false,
                  buffer: "",
                }
                loops.set(sessionID, state)
                /*
                  The first cycle goes immediately rather than waiting for an idle event: the user just
                  asked, and a loop that appears to do nothing until some later event is indistinguishable
                  from one that failed to start.
                */
                void send(state)
              }}
              onCancel={() => api.ui.dialog.clear()}
            />
          ))
        },
      },
      {
        name: "loop.stop",
        get title() {
          return kvTranslator(api.kv).t("loop.stop.title")
        },
        category: "Session",
        namespace: "palette",
        run() {
          const t = kvTranslator(api.kv)
          const sessionID = activeSessionID(api)
          if (!sessionID) return
          if (!stop(sessionID, t.t("loop.stopped.user"))) {
            api.ui.toast({
              title: t.t("loop.none.title"),
              message: t.t("loop.none.message"),
              variant: "info",
            })
          }
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("loop.palette", ["loop.start", "loop.stop"]),
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
