import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Balance } from "@redrob-code/core/balance"

/**
 * A stand-in console on loopback. Each test picks the reply by the key it sends, so the request the
 * module builds (path, query, bearer header) is checked on every call.
 */
const body = {
  currency: "USD",
  balance: 20.368355,
  complimentary: false,
  plan: "free",
  tz: "Asia/Seoul",
  today: { since: "2026-11-12T15:00:00.000Z", spend: 0, requestCount: 0 },
  month: { since: "2026-10-31T15:00:00.000Z", spend: 147.07, requestCount: 16764 },
}

const seen: { path: string; tz: string | null; auth: string | null }[] = []
let server: ReturnType<typeof Bun.serve>
let url: string

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const parsed = new URL(request.url)
      const auth = request.headers.get("authorization")
      seen.push({ path: parsed.pathname, tz: parsed.searchParams.get("tz"), auth })
      if (parsed.pathname !== "/api/backend/v1/usage/summary") return new Response("not found", { status: 404 })
      switch (auth) {
        case "Bearer ok":
          return Response.json(body)
        case "Bearer slow":
          await Bun.sleep(7_000)
          return Response.json(body)
        case "Bearer garbled":
          return new Response("{not json", { status: 200 })
        case "Bearer partial":
          return Response.json({ currency: "USD", balance: 1 })
        case "Bearer limited":
          return Response.json({ message: "slow down" }, { status: 429, headers: { "retry-after": "30" } })
        default:
          return Response.json({ message: "invalid api key" }, { status: 401 })
      }
    },
  })
  url = `http://127.0.0.1:${server.port}/api/backend/v1`
})

afterAll(() => server.stop(true))

const run = (key: string, base = url) => Effect.runPromise(Balance.summary({ url: base, key, tz: "Asia/Seoul" }))

describe("Balance.summary", () => {
  test("reads the console's summary with the key as a bearer token and the zone as a query", async () => {
    seen.length = 0
    expect(await run("ok")).toEqual(body)
    expect(seen).toEqual([{ path: "/api/backend/v1/usage/summary", tz: "Asia/Seoul", auth: "Bearer ok" }])
  })

  test("tolerates a trailing slash on the base URL", async () => {
    expect(await run("ok", `${url}/`)).toEqual(body)
  })

  test("a refused key, the rate limit and a missing route fall back quietly", async () => {
    expect(await run("wrong")).toBeUndefined()
    expect(await run("limited")).toBeUndefined()
    expect(await run("ok", `http://127.0.0.1:${server.port}/old`)).toBeUndefined()
  })

  test("a body that does not parse or misses fields falls back", async () => {
    expect(await run("garbled")).toBeUndefined()
    expect(await run("partial")).toBeUndefined()
  })

  test("an unreachable console falls back", async () => {
    expect(await run("ok", "http://127.0.0.1:1/api/backend/v1")).toBeUndefined()
  })

  test("a console slower than the timeout falls back", async () => {
    const start = Date.now()
    expect(await run("slow")).toBeUndefined()
    expect(Date.now() - start).toBeLessThan(6_500)
  }, 10_000)
})
