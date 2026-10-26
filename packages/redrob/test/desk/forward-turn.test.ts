import { describe, expect, test } from "bun:test"
import type { BusEvent, DaemonApi } from "../../src/desk/daemon"
import { Forwarder, parseModel, requestedModel } from "../../src/desk/forward"

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

describe("desk forwarder model", () => {
  const catalog = {
    data: [
      { id: "auto", providerID: "redrob", name: "Redrob Auto", capabilities: { input: ["text", "image"] } },
      { id: "openai/gpt-5", providerID: "redrob", name: "GPT-5", capabilities: { input: ["text"] } },
    ],
  }

  function setup(session: Record<string, unknown> = {}) {
    const calls: { method: string; path: string; body?: unknown }[] = []
    const daemon = {
      raw: async (method: string, path: string, body?: unknown) => {
        calls.push({ method, path, ...(body !== undefined ? { body } : {}) })
        if (path === "/api/model") return { status: 200, body: catalog }
        if (method === "GET" && path === `/api/session/${sessionID}`) return { status: 200, body: { data: session } }
        if (path === "/api/session") return { status: 200, body: { data: { id: sessionID } } }
        return { status: 200, body: {} }
      },
      events: async (_: unknown, signal: AbortSignal) =>
        new Promise((resolve) => signal.addEventListener("abort", resolve)),
    } as unknown as DaemonApi
    const forwarder = new Forwarder(
      daemon,
      async () => undefined,
      () => undefined,
    )
    const sent: Record<string, unknown>[] = []
    const link = forwarder.link(async (message) => void sent.push(message))
    const req = async (id: number, method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
      await forwarder.handle(link, { t: "req", id, method, path, body, headers })
      return sent.find((m) => m.id === id) as { status: number; body?: unknown; headers?: Record<string, string> }
    }
    return { calls, req }
  }

  test("parses <provider>/<model>, keeping slashes in the model", () => {
    expect(parseModel("redrob/openai/gpt-5")).toEqual({ providerID: "redrob", id: "openai/gpt-5" })
    expect(parseModel("redrob/auto")).toEqual({ providerID: "redrob", id: "auto" })
    expect(parseModel("auto")).toBeUndefined()
    expect(parseModel("/auto")).toBeUndefined()
    expect(parseModel("redrob/")).toBeUndefined()
    expect(parseModel("redrob/a b")).toBeUndefined()
    expect(parseModel(`redrob/${"x".repeat(300)}`)).toBeUndefined()
    expect(requestedModel({ "x-redrob-model": " redrob/auto " })).toBe("redrob/auto")
    expect(requestedModel({ "X-Redrob-Model": 3 })).toBeUndefined()
    expect(requestedModel(undefined)).toBeUndefined()
  })

  test("create puts a known model in the body and reports it", async () => {
    const { calls, req } = setup()
    const res = await req(1, "POST", "/api/session", { title: "t" }, { "X-Redrob-Model": "redrob/openai/gpt-5" })
    expect(res.status).toBe(200)
    expect(res.headers).toEqual({ "X-Redrob-Model-Applied": "redrob/openai/gpt-5" })
    expect(calls.find((c) => c.path === "/api/session")?.body).toEqual({
      title: "t",
      model: { id: "openai/gpt-5", providerID: "redrob" },
    })
  })

  test("create ignores an unknown model and says default", async () => {
    const { calls, req } = setup()
    const res = await req(1, "POST", "/api/session", { title: "t" }, { "X-Redrob-Model": "redrob/nope" })
    expect(res.headers).toEqual({ "X-Redrob-Model-Applied": "default" })
    expect(calls.find((c) => c.path === "/api/session")?.body).toEqual({ title: "t" })
  })

  test("prompt switches the session to a known model first", async () => {
    const { calls, req } = setup()
    const res = await req(
      2,
      "POST",
      `/api/session/${sessionID}/prompt`,
      { prompt: { text: "hi" } },
      { "x-redrob-model": "redrob/auto" },
    )
    expect(res.headers).toEqual({ "X-Redrob-Model-Applied": "redrob/auto" })
    const switched = calls.findIndex((c) => c.path === `/api/session/${sessionID}/model`)
    const prompted = calls.findIndex((c) => c.path === `/api/session/${sessionID}/prompt`)
    expect(switched).toBeGreaterThanOrEqual(0)
    expect(switched).toBeLessThan(prompted)
    expect(calls[switched]!.body).toEqual({ model: { id: "auto", providerID: "redrob" } })
  })

  test("prompt with an unknown model keeps the session's model and reports it", async () => {
    const kept = setup({ model: { id: "auto", providerID: "redrob" } })
    const res = await kept.req(
      3,
      "POST",
      `/api/session/${sessionID}/prompt`,
      { prompt: { text: "hi" } },
      { "X-Redrob-Model": "redrob/gone" },
    )
    expect(res.headers).toEqual({ "X-Redrob-Model-Applied": "redrob/auto" })
    expect(kept.calls.some((c) => c.path === `/api/session/${sessionID}/model`)).toBe(false)

    const fresh = setup()
    const other = await fresh.req(
      4,
      "POST",
      `/api/session/${sessionID}/prompt`,
      { prompt: { text: "hi" } },
      { "X-Redrob-Model": "bad" },
    )
    expect(other.headers).toEqual({ "X-Redrob-Model-Applied": "default" })
  })

  test("no header: nothing is switched and no applied header (older web)", async () => {
    const { calls, req } = setup()
    const res = await req(5, "POST", `/api/session/${sessionID}/prompt`, { prompt: { text: "hi" } })
    expect(res.headers).toBeUndefined()
    expect(calls.map((c) => c.path)).not.toContain(`/api/session/${sessionID}/model`)
  })

  test("GET /desk/models lists the catalog", async () => {
    const { req } = setup()
    const res = await req(6, "GET", "/desk/models")
    expect(res).toMatchObject({
      status: 200,
      body: {
        v: 1,
        models: [
          { id: "redrob/auto", name: "Redrob Auto", imageInput: true },
          { id: "redrob/openai/gpt-5", name: "GPT-5", imageInput: false },
        ],
      },
    })
  })
})
