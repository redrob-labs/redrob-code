import type { EngineEvent } from "../engine"

/**
 * Text that is still streaming, keyed by text id, for one session.
 *
 * Committed messages come from `messages.list`; this only covers the gap between a `text.delta`
 * arriving and the step ending, so the person sees the answer form instead of waiting for it whole.
 */
export type LiveText = Record<string, string>

export function applyLiveEvent(state: LiveText, event: EngineEvent, sessionID: string): LiveText {
  if (event.data?.sessionID !== sessionID) return state
  const textID = typeof event.data.textID === "string" ? event.data.textID : null
  switch (event.type) {
    case "session.next.text.started":
      return textID ? { ...state, [textID]: "" } : state
    case "session.next.text.delta":
      return textID && typeof event.data.delta === "string"
        ? { ...state, [textID]: (state[textID] ?? "") + event.data.delta }
        : state
    case "session.next.step.ended":
    case "session.next.step.failed":
      return {}
    default:
      return state
  }
}

/** Events after which the committed message list has changed and should be read again. */
export function changesMessages(event: EngineEvent, sessionID: string) {
  if (event.data?.sessionID !== sessionID) return false
  return [
    "session.next.prompted",
    "session.next.prompt.admitted",
    "session.next.text.ended",
    "session.next.tool.called",
    "session.next.tool.success",
    "session.next.tool.failed",
    "session.next.step.ended",
    "session.next.step.failed",
    "session.next.shell.ended",
    "session.next.compaction.ended",
  ].includes(event.type)
}

/** A short, single-line description of what a tool was asked to do. */
export function describeToolInput(input: unknown): string {
  if (typeof input === "string") return input.slice(0, 160)
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  for (const key of ["filePath", "path", "command", "pattern", "url", "description"]) {
    const value = record[key]
    if (typeof value === "string" && value) return value.slice(0, 160)
  }
  return ""
}
