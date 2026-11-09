import { describe, expect, test } from "bun:test"
import type { BusEvent, DaemonApi } from "../../src/desk/daemon"
import { capabilities, Forwarder, match } from "../../src/desk/forward"

const routine = (over: Record<string, unknown> = {}) => ({
  id: "rtn_1",
  sessionID: "ses_a",
  goal: "fix CI",
  trigger: { type: "watch", kind: "ci_run", url: "https://github.com/o/r/actions/runs/42", interval: 300 },
  status: "running",
  cycles: 0,
  maxCycles: 20,
  rejected: [],
  time: { created: 1, updated: 2 },
  ...over,
})

function harness(raw: (method: string, path: string, body?: unknown) => { status: number; body?: unknown }) {
  const calls: string[] = []
  let emit: (event: BusEvent) => void = () => undefined
  const daemon = {
    raw: async (method: string, path: string, body?: unknown) => {
      if (path !== "/api/model") calls.push(`${method} ${path}${body !== undefined ? ` ${JSON.stringify(body)}` : ""}`)
      return raw(method, path, body)
    },
    events: async (listener: (event: BusEvent) => void, signal: AbortSignal) => {
      emit = listener
      await new Promise((resolve) => signal.addEventListener("abort", resolve))
    },
  } as unknown as DaemonApi
  const forwarder = new Forwarder(daemon, async () => undefined, () => undefined)
  const sent: Record<string, unknown>[] = []
  const link = forwarder.link(async (message) => void sent.push(message))
  const req = async (method: string, path: string, body?: unknown) => {
    sent.length = 0
    await forwarder.handle(link, { t: "req", id: 1, method, path, ...(body !== undefined ? { body } : {}) })
    return sent.find((frame) => frame.t === "res") as { status: number; body?: any }
  }
  return { forwarder, calls, req, emit: (event: BusEvent) => emit(event), sent }
}

describe("desk routine routes", () => {
  test("the routes are allowed and checked", () => {
    expect(match({ method: "GET", path: "/desk/routine" })).toBeDefined()
    expect(match({ method: "GET", path: "/desk/routine?sessionID=ses_a" })).toBeDefined()
    expect(match({ method: "POST", path: "/desk/routine/rtn_1/stop" })).toBeDefined()
    expect(match({ method: "POST", path: "/desk/snapshot/ses_a/revert", body: { messageID: "msg_1" } })).toBeDefined()
    expect(match({ method: "POST", path: "/desk/snapshot/ses_a/revert", body: { messageID: "../x" } })).toBeUndefined()
    expect(match({ method: "POST", path: "/desk/snapshot/ses_a/revert", body: { other: 1 } })).toBeUndefined()
    expect(match({ method: "POST", path: "/desk/snapshot/ses_a/unrevert" })).toBeDefined()
    expect(match({ method: "POST", path: "/desk/routine/../stop" })).toBeUndefined()
  })

  test("GET /desk/routine lists routines with the wait block data", async () => {
    const schedule = routine({ id: "rtn_2", trigger: { type: "schedule", cron: "0 9 * * 1" } })
    const { req, calls } = harness(() => ({ status: 200, body: [routine(), schedule] }))
    const res = await req("GET", "/desk/routine?sessionID=ses_a")
    expect(calls).toEqual(["GET /routine?sessionID=ses_a"])
    expect(res.status).toBe(200)
    expect(res.body.routines).toHaveLength(2)
    expect(res.body.routines[0].wait).toEqual({
      what: "o/r CI 42",
      every: 300,
      state: "waiting",
      stopId: "rtn_1",
      kind: "ci_run",
      url: "https://github.com/o/r/actions/runs/42",
    })
    expect(res.body.routines[0].where).toBe("pc")
    expect(res.body.routines[1].wait).toBeUndefined()
    expect((await req("GET", "/desk/routine?sessionID=../../x")).status).toBe(400)
  })

  test("POST /desk/routine/:id/stop stops it", async () => {
    const { req, calls } = harness(() => ({ status: 200, body: routine({ status: "stopped", reason: "Stopped by the user." }) }))
    const res = await req("POST", "/desk/routine/rtn_1/stop")
    expect(calls).toEqual(["POST /routine/rtn_1/stop"])
    expect(res.body.routine.wait.state).toBe("stopped")
    expect(res.body.routine.wait.reason).toBe("Stopped by the user.")
  })

  test("revert goes back to before the session's first prompt by default", async () => {
    const { req, calls } = harness((method, path) => {
      if (path.startsWith("/api/session/ses_a/history"))
        return {
          status: 200,
          body: {
            hasMore: false,
            data: [
              { type: "session.created", data: {}, durable: { seq: 0 } },
              { type: "session.next.prompted", data: { messageID: "msg_first" }, durable: { seq: 1 } },
              { type: "session.next.prompted", data: { messageID: "msg_second" }, durable: { seq: 5 } },
            ],
          },
        }
      return {
        status: 200,
        body: {
          data: {
            messageID: "msg_first",
            files: [{ path: "merged.csv", status: "added", additions: 2, deletions: 0, patch: "..." }],
          },
        },
      }
    })
    const res = await req("POST", "/desk/snapshot/ses_a/revert")
    expect(calls).toEqual([
      "GET /api/session/ses_a/history?limit=100",
      'POST /api/session/ses_a/revert/stage {"messageID":"msg_first"}',
    ])
    expect(res.body).toEqual({
      v: 1,
      sessionID: "ses_a",
      messageID: "msg_first",
      files: [{ path: "merged.csv", status: "added", additions: 2, deletions: 0 }],
    })

    calls.length = 0
    await req("POST", "/desk/snapshot/ses_a/revert", { messageID: "msg_second" })
    expect(calls).toEqual(['POST /api/session/ses_a/revert/stage {"messageID":"msg_second"}'])

    calls.length = 0
    expect((await req("POST", "/desk/snapshot/ses_a/unrevert")).status).toBe(200)
    expect(calls).toEqual(["POST /api/session/ses_a/revert/clear"])
  })

  test("a routine change reaches every device as routine.wait", async () => {
    const { forwarder, emit, sent } = harness(() => ({ status: 200 }))
    forwarder.start()
    await Bun.sleep(0)
    emit({ type: "routine.updated", data: { info: routine({ status: "done", reason: "The goal is met." }) } })
    await Bun.sleep(150)
    forwarder.stop()
    const events = sent.flatMap((frame) => (frame.t === "evts" ? (frame.events as BusEvent[]) : []))
    expect(events.map((event) => event.type)).toEqual(["routine.wait"])
    expect(events[0]!.data.sessionID).toBe("ses_a")
    expect((events[0]!.data.routine as { wait: { state: string } }).wait.state).toBe("done")
  })

  test("capabilities lists the features", async () => {
    expect((await capabilities()).features).toEqual(expect.arrayContaining(["routine", "snapshot"]))
  })
})
