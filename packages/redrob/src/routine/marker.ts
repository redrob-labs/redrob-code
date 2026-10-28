/**
 * The words a routine's prompt and its reply share, and the pure rules that read them.
 *
 * Moved here from the terminal's autopilot so every trigger (after a turn, on a schedule, on a
 * watched change) builds the same prompt and judges the reply the same way, and so a phone or the
 * web can start one without the terminal open.
 *
 * Why the ledger: re-sending one fixed sentence gives the model the same input every cycle, so it
 * cannot notice it is going in circles. Each cycle therefore carries the goal, the approaches
 * already rejected, and a request to assess before taking the next step.
 */

/** A backstop, not a target. A routine that reaches this did not finish; it ran out of rope. */
export const DEFAULT_MAX_CYCLES = 25

/**
 * How many identical next-steps in a row count as stuck. Two is too eager: a model legitimately
 * repeats a step while waiting for a build. Three identical plans is a loop with no exit.
 */
export const STALL_THRESHOLD = 3

/** Exact strings, because they are a contract between the prompt text and the parser. */
export const MARKERS = {
  done: "AUTOPILOT: GOAL MET",
  blocked: "AUTOPILOT: BLOCKED",
  next: "AUTOPILOT NEXT:",
  rejected: "AUTOPILOT REJECTED:",
} as const

export interface Ledger {
  readonly rejected: string[]
  readonly recentNext: string[]
}

export const emptyLedger = (): Ledger => ({ rejected: [], recentNext: [] })

export interface Markers {
  readonly done: boolean
  readonly blocked: boolean
  readonly next: string | undefined
  readonly rejected: string[]
}

/** Pull the markers out of a reply. Tolerant of surrounding prose; models add it. */
export function readMarkers(text: string): Markers {
  const lines = text.split("\n").map((line) => line.trim())
  const after = (prefix: string) =>
    lines.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length).trim())
  const nextLines = after(MARKERS.next)
  return {
    done: text.includes(MARKERS.done),
    blocked: text.includes(MARKERS.blocked),
    // The LAST plan wins: a model that revises mid-reply meant the revision.
    next: nextLines.length > 0 ? nextLines[nextLines.length - 1] : undefined,
    rejected: after(MARKERS.rejected).filter((line) => line.length > 0),
  }
}

/** Whether the recent plans repeat. Compared after normalising whitespace, case and end punctuation. */
export function isStalled(recentNext: readonly string[], threshold = STALL_THRESHOLD): boolean {
  if (recentNext.length < threshold) return false
  const tail = recentNext.slice(-threshold).map((line) =>
    line
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[.!]+$/, ""),
  )
  return tail.every((line) => line.length > 0 && line === tail[0])
}

/** Folds one reply into the ledger. Returns a new ledger; the old one is left alone. */
export function applyMarkers(ledger: Ledger, markers: Markers): Ledger {
  const rejected = [...ledger.rejected]
  for (const item of markers.rejected) if (!rejected.includes(item)) rejected.push(item)
  // Only the tail is ever read, so the stored list stays short.
  const recentNext = markers.next ? [...ledger.recentNext, markers.next].slice(-STALL_THRESHOLD * 2) : ledger.recentNext
  return { rejected, recentNext }
}

export type Wake =
  | { readonly type: "after_turn" }
  | { readonly type: "schedule" }
  | { readonly type: "watch"; readonly change: string }

/** The prompt for one cycle. Built fresh every time because the ledger and cycle number move. */
export function cyclePrompt(input: {
  readonly goal: string
  readonly ledger: Ledger
  readonly cycle: number
  readonly maxCycles: number
  readonly wake: Wake
}): string {
  const opening =
    input.wake.type === "after_turn"
      ? `You are on autopilot. This is cycle ${input.cycle} of at most ${input.maxCycles}.`
      : input.wake.type === "schedule"
        ? `A scheduled routine woke you. This is run ${input.cycle} of at most ${input.maxCycles}.`
        : `A watched subject changed and woke you. This is run ${input.cycle} of at most ${input.maxCycles}.`

  const parts: string[] = [opening, "", "GOAL", input.goal]

  if (input.wake.type === "watch") parts.push("", "WHAT CHANGED", input.wake.change)

  if (input.ledger.rejected.length > 0) {
    parts.push(
      "",
      "ALREADY TRIED AND REJECTED -- do not repeat these:",
      ...input.ledger.rejected.map((item) => `- ${item}`),
    )
  }

  parts.push(
    "",
    "Assess where the work stands against the GOAL, then take the single next step. Do the work; do not",
    "just describe it.",
    "",
    "End your reply with these lines:",
    `  ${MARKERS.next} <the one concrete step you will take next>`,
    `  ${MARKERS.rejected} <an approach you just ruled out>   (only if you ruled one out)`,
    "",
    input.wake.type === "after_turn"
      ? `When the GOAL is met, say ${MARKERS.done} and state how you verified it.`
      : `Say ${MARKERS.done} only when the GOAL is fully met and this routine should stop running.`,
    `If you cannot proceed without a person -- a decision, a credential, an access you lack -- say`,
    `${MARKERS.blocked} and say what you need. Do not guess at it and do not keep trying.`,
  )

  return parts.join("\n")
}

export type Verdict =
  | { readonly type: "continue"; readonly ledger: Ledger }
  | { readonly type: "done"; readonly ledger: Ledger }
  | { readonly type: "blocked"; readonly ledger: Ledger }
  | { readonly type: "stalled"; readonly ledger: Ledger; readonly step: string }
  | { readonly type: "exhausted"; readonly ledger: Ledger }

/**
 * What one finished cycle means for the routine. Stall detection applies only to after_turn: a
 * schedule that does the same thing every morning is working, not circling.
 */
export function judge(input: {
  readonly reply: string
  readonly ledger: Ledger
  readonly cycles: number
  readonly maxCycles: number
  readonly trigger: "after_turn" | "schedule" | "watch"
}): Verdict {
  const markers = readMarkers(input.reply)
  const ledger = applyMarkers(input.ledger, markers)
  if (markers.done) return { type: "done", ledger }
  if (markers.blocked) return { type: "blocked", ledger }
  if (input.trigger === "after_turn" && isStalled(ledger.recentNext)) {
    return { type: "stalled", ledger, step: ledger.recentNext.at(-1) ?? "" }
  }
  if (input.cycles >= input.maxCycles) return { type: "exhausted", ledger }
  return { type: "continue", ledger }
}

export * as RoutineMarker from "./marker"
