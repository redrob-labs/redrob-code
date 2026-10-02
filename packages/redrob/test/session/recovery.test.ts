import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@redrob-code/core/v1/session"
import { MESSAGE_INTERRUPTED, TOOL_INTERRUPTED, SessionRecovery } from "../../src/session/recovery"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const sessionID = SessionID.make("ses_recovery")
const messageID = MessageID.make("msg_recovery")

const assistant = (overrides?: Partial<SessionV1.Assistant>): SessionV1.Assistant =>
  ({
    id: messageID,
    sessionID,
    role: "assistant",
    system: [],
    modelID: "model",
    providerID: "provider",
    mode: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_000 },
    ...overrides,
  }) as unknown as SessionV1.Assistant

/** The completion stamp only exists on an assistant message, so reach it through the role. */
const completedAt = (message: SessionV1.Info | undefined) =>
  message?.role === "assistant" ? message.time.completed : undefined

const toolPart = (state: SessionV1.ToolState, id = "prt_tool"): SessionV1.ToolPart =>
  ({
    id: PartID.make(id),
    sessionID,
    messageID,
    type: "tool",
    callID: "call_1",
    tool: "write",
    state,
  }) as SessionV1.ToolPart

const textPart = (): SessionV1.TextPart =>
  ({
    id: PartID.make("prt_text"),
    sessionID,
    messageID,
    type: "text",
    text: "half a sentence",
  }) as SessionV1.TextPart

describe("SessionRecovery.reconcile — what an engine restart does to an interrupted turn", () => {
  test("a running tool call becomes a terminal error that says it may be half-applied", () => {
    const result = SessionRecovery.reconcile({
      candidate: {
        message: assistant(),
        parts: [toolPart({ status: "running", input: { filePath: "/tmp/x" }, time: { start: 1_100 } })],
      },
      now: 5_000,
    })

    expect(result.parts).toHaveLength(1)
    const state = (result.parts[0] as SessionV1.ToolPart).state
    expect(state.status).toBe("error")
    if (state.status !== "error") throw new Error("unreachable")
    expect(state.error).toBe(TOOL_INTERRUPTED)
    // The input survives, because the input is the only record of what was being applied.
    expect(state.input).toEqual({ filePath: "/tmp/x" })
    expect(state.time).toEqual({ start: 1_100, end: 5_000 })
  })

  test("a pending tool call — accepted by the model, never started — is closed out too", () => {
    const result = SessionRecovery.reconcile({
      candidate: {
        message: assistant(),
        parts: [toolPart({ status: "pending", input: { filePath: "/tmp/x" }, raw: "{}" })],
      },
      now: 5_000,
    })

    expect(result.parts).toHaveLength(1)
    const state = (result.parts[0] as SessionV1.ToolPart).state
    if (state.status !== "error") throw new Error("expected error state")
    // A pending call has no start of its own, so the message's creation time is used.
    expect(state.time).toEqual({ start: 1_000, end: 5_000 })
  })

  test("the assistant message is stamped completed and carries an aborted error", () => {
    const result = SessionRecovery.reconcile({ candidate: { message: assistant(), parts: [] }, now: 5_000 })

    expect(completedAt(result.message)).toBe(5_000)
    expect(result.message?.role === "assistant" ? result.message.error : undefined).toEqual({
      name: "MessageAbortedError",
      data: { message: MESSAGE_INTERRUPTED },
    })
  })

  test("an error the engine already recorded is not overwritten by the generic one", () => {
    const existing = { name: "MessageAbortedError", data: { message: "User aborted" } } as const
    const result = SessionRecovery.reconcile({
      candidate: { message: assistant({ error: existing }), parts: [] },
      now: 5_000,
    })

    expect(result.message?.role === "assistant" ? result.message.error : undefined).toEqual(existing)
  })

  test("a completed message is left alone, which is what makes a second sweep a no-op", () => {
    const completed = assistant({ time: { created: 1_000, completed: 2_000 } })
    const result = SessionRecovery.reconcile({
      candidate: {
        message: completed,
        parts: [toolPart({ status: "running", input: {}, time: { start: 1_100 } })],
      },
      now: 5_000,
    })

    expect(result.message).toBeUndefined()
    expect(result.parts).toEqual([])
  })

  test("reconciling the reconciled output changes nothing", () => {
    const first = SessionRecovery.reconcile({
      candidate: {
        message: assistant(),
        parts: [toolPart({ status: "running", input: {}, time: { start: 1_100 } })],
      },
      now: 5_000,
    })
    const second = SessionRecovery.reconcile({
      candidate: { message: first.message!, parts: first.parts },
      now: 9_000,
    })

    expect(second.message).toBeUndefined()
    expect(second.parts).toEqual([])
  })

  test("terminal tool calls and non-tool parts are not rewritten", () => {
    const result = SessionRecovery.reconcile({
      candidate: {
        message: assistant(),
        parts: [
          toolPart(
            {
              status: "completed",
              input: {},
              output: "done",
              title: "t",
              metadata: {},
              time: { start: 1, end: 2 },
            },
            "prt_done",
          ),
          toolPart({ status: "error", input: {}, error: "nope", time: { start: 1, end: 2 } }, "prt_err"),
          textPart(),
        ],
      },
      now: 5_000,
    })

    // Only the message is closed out; no part is touched.
    expect(result.parts).toEqual([])
    expect(completedAt(result.message)).toBe(5_000)
  })

  test("a user message is never touched, even though it has no completion stamp", () => {
    const user = {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: 1_000 },
    } as unknown as SessionV1.Info
    const result = SessionRecovery.reconcile({ candidate: { message: user, parts: [] }, now: 5_000 })

    expect(result.message).toBeUndefined()
    expect(result.parts).toEqual([])
  })

  test("a clock that went backwards cannot produce an end before the start", () => {
    const result = SessionRecovery.reconcile({
      candidate: {
        message: assistant(),
        parts: [toolPart({ status: "running", input: {}, time: { start: 9_000 } })],
      },
      now: 5_000,
    })

    const state = (result.parts[0] as SessionV1.ToolPart).state
    if (state.status !== "error") throw new Error("expected error state")
    expect(state.time).toEqual({ start: 9_000, end: 9_000 })
  })
})
