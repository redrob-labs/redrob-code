import type { BuildoffMessage, BuildoffResult } from "@redrob-code/desktop/bridge"

/**
 * The live state of one build-off, folded from the messages the main process sends.
 * Pure, so the screen's behaviour can be tested without Electron.
 */

export type Lane = { slot: string; status: string; costUsd: number; tools: number }

export type RunState = {
  runId: string
  stage: string
  detail?: string
  lanes: Lane[]
  notes: string[]
  result: BuildoffResult | null
  error: string | null
}

export const STAGES = ["preparing", "baseline", "building", "verifying", "reviewing", "gating", "ready"] as const

export function initialRun(runId: string): RunState {
  return { runId, stage: "preparing", lanes: [], notes: [], result: null, error: null }
}

export function reduce(state: RunState, message: BuildoffMessage): RunState {
  if (message.runId !== state.runId) return state
  if (message.kind === "error") return { ...state, error: message.message }
  if (message.kind === "result") return { ...state, stage: "ready", result: message.result }
  const event = message.event
  if (event.type === "stage") return { ...state, stage: event.stage, detail: event.detail }
  if (event.type === "note") return { ...state, notes: [...state.notes, event.message] }
  const existing = state.lanes.find((lane) => lane.slot === event.slot)
  const lane: Lane = {
    slot: event.slot,
    status: event.status,
    costUsd: event.costUsd ?? existing?.costUsd ?? 0,
    tools: event.tools ?? existing?.tools ?? 0,
  }
  const lanes = existing
    ? state.lanes.map((entry) => (entry.slot === event.slot ? lane : entry))
    : [...state.lanes, lane].sort((a, b) => a.slot.localeCompare(b.slot))
  return { ...state, lanes }
}

/** How far along the pipeline the run is, 0-100, for a progress bar. */
export function progress(stage: string) {
  const index = STAGES.indexOf(stage as (typeof STAGES)[number])
  if (stage === "escalating") return 60
  return index < 0 ? 0 : Math.round((index / (STAGES.length - 1)) * 100)
}

/**
 * Who beat whom: for every ordered pair of slots, "win", "loss", "tie" or null when the pair was not
 * judged. This is the disagreement map: a tie means the reviewers disagreed or flipped with the order.
 */
export function matrix(result: BuildoffResult) {
  const slots = result.candidates.map((candidate) => candidate.slot)
  const cell = (row: string, column: string): "win" | "loss" | "tie" | null => {
    if (row === column) return null
    const outcome = result.outcomes.find(
      (entry) => (entry.a === row && entry.b === column) || (entry.a === column && entry.b === row),
    )
    if (!outcome) return null
    if (outcome.winner === "tie") return "tie"
    return outcome.winner === row ? "win" : "loss"
  }
  return { slots, cell }
}
