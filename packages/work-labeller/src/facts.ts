/*
 * What a session recorder keeps from an app's agent events: counts, flags and times, never text.
 *
 * Each app reduces its own events to these facts (Cowork: engine bus events, in its OpenCode plugin;
 * Office: AgentLoop callbacks; Design: its chat and editor events). Where something written decides a
 * flag, such as a command that runs tests, the app computes the flag and only the boolean is a fact.
 */

export type Fact =
  | { kind: "session"; sessionID: string; parentID: string | null; at: number }
  | { kind: "user-turn"; sessionID: string; messageID: string; at: number; attachedSource: boolean }
  | { kind: "assistant-done"; sessionID: string; messageID: string; at: number }
  | { kind: "tool"; sessionID: string; callID: string; at: number; status: "running" | "completed" | "error"; effect: ToolEffect }
  | { kind: "permission"; sessionID: string; at: number; asked: boolean; reply: "once" | "always" | "reject" | null }
  | { kind: "busy"; sessionID: string; at: number; busy: boolean }
  | { kind: "aborted"; sessionID: string; at: number }
  | { kind: "idle"; sessionID: string; at: number };

/** What a tool call did, as far as the labels care. */
export type ToolEffect = "artifact" | "checks" | "delegates" | "sends" | "reads" | "other";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

const EFFECTS: readonly ToolEffect[] = ["artifact", "checks", "delegates", "sends", "reads", "other"];

/**
 * A fact as a recorder receives it from another process, checked field by field. Anything else in the object is
 * dropped, so the shape is the only thing that can be stored, whatever a caller sends.
 */
export function parseFact(value: unknown): Fact | null {
  const kind = str(field(value, "kind"));
  const sessionID = str(field(value, "sessionID"));
  const at = num(field(value, "at"));
  if (!kind || !sessionID || at === null) return null;
  switch (kind) {
    case "session": {
      const parentID = field(value, "parentID");
      return { kind, sessionID, at, parentID: typeof parentID === "string" && parentID ? parentID : null };
    }
    case "user-turn": {
      const messageID = str(field(value, "messageID"));
      return messageID ? { kind, sessionID, at, messageID, attachedSource: field(value, "attachedSource") === true } : null;
    }
    case "assistant-done": {
      const messageID = str(field(value, "messageID"));
      return messageID ? { kind, sessionID, at, messageID } : null;
    }
    case "tool": {
      const callID = str(field(value, "callID"));
      const status = field(value, "status");
      const effect = EFFECTS.find((e) => e === field(value, "effect"));
      if (!callID || !effect || (status !== "running" && status !== "completed" && status !== "error")) return null;
      return { kind, sessionID, at, callID, status, effect };
    }
    case "permission": {
      const reply = field(value, "reply");
      return {
        kind,
        sessionID,
        at,
        asked: field(value, "asked") === true,
        reply: reply === "once" || reply === "always" || reply === "reject" ? reply : null,
      };
    }
    case "busy":
      return { kind, sessionID, at, busy: field(value, "busy") === true };
    case "aborted":
    case "idle":
      return { kind, sessionID, at };
    default:
      return null;
  }
}
