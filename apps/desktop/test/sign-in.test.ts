import { expect, test } from "bun:test"
import type { SignInProgress } from "../src/shared/bridge"
import { consoleUrl, createSignIn, deviceError } from "../src/main/sign-in"

function console_(replies: { status: number; body: unknown }[]) {
  const calls: { url: string; body: unknown }[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) })
    const reply = replies.shift()!
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const authorization = {
  status: 200,
  body: {
    deviceCode: "dev-1",
    userCode: "K7QM-2XR9",
    verificationUri: "https://console.redrob.ai/connect",
    verificationUriComplete: "https://console.redrob.ai/connect?code=K7QM-2XR9",
    expiresIn: 600,
    interval: 5,
  },
}

test("the key goes to the engine and never into a progress event", async () => {
  const { fetch, calls } = console_([
    authorization,
    { status: 400, body: { error: "authorization_pending" } },
    { status: 400, body: { error: "slow_down" } },
    { status: 200, body: { apiKey: "rrk_abc_secret", apiKeyName: "Redrob Code (2026-10-11)", accountName: "Acme" } },
  ])
  const progress: SignInProgress[] = []
  const stored: string[] = []
  const opened: string[] = []
  const waits: number[] = []
  const flow = createSignIn({
    consoleUrl: "https://c/api/backend/v1",
    fetch,
    openExternal: async (url) => void opened.push(url),
    storeKey: async (key) => void stored.push(key),
    onProgress: (p) => progress.push(p),
    sleep: async (ms) => void waits.push(ms),
    now: () => 0,
  })
  await flow.start()

  expect(calls[0]).toEqual({ url: "https://c/api/backend/v1/device/authorize", body: { product: "code" } })
  expect(opened).toEqual(["https://console.redrob.ai/connect?code=K7QM-2XR9"])
  expect(stored).toEqual(["rrk_abc_secret"])
  // slow_down adds five seconds to every later poll, as RFC 8628 asks.
  expect(waits).toEqual([5000, 5000, 10000])
  expect(progress.at(-1)).toEqual({ status: "connected", accountName: "Acme", keyName: "Redrob Code (2026-10-11)" })
  expect(JSON.stringify(progress)).not.toContain("rrk_abc_secret")
})

test("a denial stops polling and says so", async () => {
  const { fetch } = console_([authorization, { status: 403, body: { error: { code: "access_denied" } } }])
  const progress: SignInProgress[] = []
  const flow = createSignIn({
    consoleUrl: "https://c",
    fetch,
    openExternal: async () => {},
    storeKey: async () => {
      throw new Error("must not be called")
    },
    onProgress: (p) => progress.push(p),
    sleep: async () => {},
    now: () => 0,
  })
  await flow.start()
  expect(progress.at(-1)).toEqual({ status: "denied" })
})

test("console url honours the engine's override flag", () => {
  expect(consoleUrl({})).toBe("https://console.redrob.ai/api/backend/v1")
  expect(consoleUrl({ REDROB_CONSOLE_URL: "http://localhost:3001/api/backend/v1/" })).toBe(
    "http://localhost:3001/api/backend/v1",
  )
  expect(deviceError({ code: "expired_token" })).toBe("expired_token")
})
