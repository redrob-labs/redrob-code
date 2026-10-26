import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { BusEvent, DaemonApi } from "../../src/desk/daemon"
import { ATTACHMENT_CHUNK_BYTES, Forwarder, match } from "../../src/desk/forward"

const sessionID = "ses_attach"
let dir: string | undefined

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

/** A forwarder whose bus delivers `events` once, and the replies it sends to one link. */
async function setup(events: BusEvent[]) {
  const calls: string[] = []
  const daemon = {
    raw: async (_method: string, requestPath: string) => (calls.push(requestPath), { status: 200, body: {} }),
    events: async (listener: (event: BusEvent) => void, signal: AbortSignal) => {
      for (const event of events) listener(event)
      await new Promise((resolve) => signal.addEventListener("abort", resolve))
    },
  } as unknown as DaemonApi
  const forwarder = new Forwarder(
    daemon,
    async () => undefined,
    () => undefined,
  )
  forwarder.start()
  await Bun.sleep(0)
  const replies: Record<string, unknown>[] = []
  const link = forwarder.link(async (message) => void replies.push(message))
  const get = async (requestPath: string) => {
    await forwarder.handle(link, { t: "req", id: replies.length + 1, method: "GET", path: requestPath })
    return replies.at(-1) as {
      status: number
      body?: { name: string; mime: string; size: number; offset: number; data: string }
    }
  }
  return { forwarder, get, calls }
}

const attachment = (file: string, id = "att_1") => ({
  type: "session.next.attachment",
  data: { sessionID, id, name: path.basename(file), mime: "image/png", size: 0, source: "read", path: file },
})

describe("desk attachment route", () => {
  test("is on the allowlist with its query, and other desk paths stay off it", () => {
    expect(match({ method: "GET", path: `/desk/attachment/${sessionID}/att_1?offset=0&limit=10` })?.params).toEqual([
      sessionID,
      "att_1",
    ])
    expect(match({ method: "POST", path: `/desk/attachment/${sessionID}/att_1` })).toBeUndefined()
    expect(match({ method: "GET", path: `/desk/attachment/${sessionID}/../etc` })).toBeUndefined()
    expect(match({ method: "GET", path: "/desk/files" })).toBeUndefined()
  })

  test("serves an announced attachment in 512 KB pieces", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "desk-attach-"))
    const file = path.join(dir, "george-v3.png")
    const bytes = Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 100, 7)
    await writeFile(file, bytes)
    const { forwarder, get, calls } = await setup([attachment(file)])

    const first = await get(`/desk/attachment/${sessionID}/att_1`)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ name: "george-v3.png", mime: "image/png", size: bytes.length, offset: 0 })
    expect(Buffer.from(first.body!.data, "base64").length).toBe(ATTACHMENT_CHUNK_BYTES)

    const rest = await get(
      `/desk/attachment/${sessionID}/att_1?offset=${ATTACHMENT_CHUNK_BYTES}&limit=${ATTACHMENT_CHUNK_BYTES * 4}`,
    )
    expect(rest.body?.offset).toBe(ATTACHMENT_CHUNK_BYTES)
    expect(Buffer.from(rest.body!.data, "base64").length).toBe(100)

    // Never forwarded to the daemon (the link only warmed the catalog).
    expect(calls).toEqual(["/api/model"])
    forwarder.stop()
  })

  test("answers 404 for an attachment the bus never announced", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "desk-attach-"))
    const file = path.join(dir, "a.png")
    await writeFile(file, "x")
    const { forwarder, get } = await setup([attachment(file)])
    expect((await get(`/desk/attachment/${sessionID}/att_2`)).status).toBe(404)
    expect((await get(`/desk/attachment/ses_other/att_1`)).status).toBe(404)
    expect((await get(`/desk/attachment/${sessionID}/att_1?offset=-1`)).status).toBe(400)
    forwarder.stop()
  })
})

describe("desk live events", () => {
  test("a device link warms the catalog once, and each delta goes out before the turn ends", async () => {
    const calls: string[] = []
    let emit: (event: BusEvent) => void = () => undefined
    const daemon = {
      raw: async (_method: string, requestPath: string) => (calls.push(requestPath), { status: 200, body: {} }),
      events: async (listener: (event: BusEvent) => void, signal: AbortSignal) => {
        emit = listener
        await new Promise((resolve) => signal.addEventListener("abort", resolve))
      },
    } as unknown as DaemonApi
    const forwarder = new Forwarder(daemon, async () => undefined, () => undefined)
    forwarder.start()
    await Bun.sleep(0)
    const sent: { at: number; types: string[] }[] = []
    const link = forwarder.link(async (message) => {
      const events = (message as { events?: BusEvent[] }).events ?? []
      sent.push({ at: Date.now(), types: events.map((e) => e.type) })
    })
    forwarder.link(async () => undefined)
    expect(calls).toEqual(["/api/model"])
    await forwarder.handle(link, { t: "sub", sessions: [sessionID] })

    const delta = (n: number) => ({ type: "session.next.text.delta", data: { sessionID, textID: "t1", delta: `d${n}` } })
    const started = Date.now()
    emit(delta(0))
    await Bun.sleep(20)
    // The first event after a quiet spell is not held for the coalescing window.
    expect(sent.map((s) => s.types)).toEqual([["session.next.text.delta"]])
    expect(sent[0]!.at - started).toBeLessThan(50)
    for (let n = 1; n < 4; n++) {
      emit(delta(n))
      await Bun.sleep(150)
    }
    // Every delta reached the device while the turn is still running (no step.ended yet).
    expect(sent.length).toBe(4)
    for (let n = 1; n < 4; n++) expect(sent[n]!.at - sent[n - 1]!.at).toBeLessThan(300)
    forwarder.stop()
  })
})
