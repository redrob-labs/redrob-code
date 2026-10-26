import { describe, expect, test } from "bun:test"
import type { BusEvent, DaemonApi } from "../../src/desk/daemon"
import { Forwarder } from "../../src/desk/forward"

const sessionID = "ses_turn"

describe("desk forwarder turn end", () => {
  test("a failed step ends the turn and relays its error", async () => {
    let emit: (event: BusEvent) => void = () => undefined
    const daemon = {
      raw: async () => ({ status: 200, body: {} }),
      events: async (listener: (event: BusEvent) => void, signal: AbortSignal) => {
        emit = listener
        await new Promise((resolve) => signal.addEventListener("abort", resolve))
      },
    } as unknown as DaemonApi
    const notified: string[] = []
    const forwarder = new Forwarder(
      daemon,
      async (kind, id) => void notified.push(`${kind}:${id}`),
      () => undefined,
    )
    forwarder.start()
    await Bun.sleep(0)
    const sent: Record<string, unknown>[] = []
    const link = forwarder.link(async (message) => void sent.push(message))
    await forwarder.handle(link, { t: "sub", sessions: [sessionID] })
    await forwarder.handle(link, {
      t: "req",
      id: 1,
      method: "POST",
      path: `/api/session/${sessionID}/prompt`,
      body: { prompt: { text: "hi" } },
    })

    const message = `No model is available for session ${sessionID}`
    emit({
      type: "session.next.step.failed",
      data: { sessionID, assistantMessageID: "msg_1", error: { type: "unknown", message } },
    })
    await Bun.sleep(150)
    forwarder.stop()

    const events = sent.flatMap((frame) => (frame.t === "evts" ? (frame.events as BusEvent[]) : []))
    expect(events.map((event) => event.type)).toEqual(["session.next.step.failed", "session.idle"])
    expect(events[1]!.data).toEqual({ sessionID, error: message })
    // A phone was watching, so no push.
    expect(notified).toEqual([])
  })
})
