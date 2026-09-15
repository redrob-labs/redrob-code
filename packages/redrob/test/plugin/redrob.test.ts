import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@redrob-code/plugin"
import {
  collectDeviceToken,
  pollDeviceToken,
  RedrobAuthPlugin,
  requestDeviceAuthorization,
  type RedrobAuthPluginOptions,
  type RedrobDeviceAuthorization,
} from "../../src/plugin/redrob"
import { CONSOLE_URL } from "@redrob-code/core/plugin/provider/redrob-constants"

/**
 * A stand-in console, not a mock: a real HTTP server on a real port answering with the bodies the
 * console's own DeviceService returns, so the protocol mapping is exercised over the wire rather
 * than asserted against a hand-written double of our own client.
 */
function serveConsole(handler: (request: Request, url: URL, body: Record<string, unknown>) => Response) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      return handler(request, new URL(request.url), body)
    },
  })
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** The verification page as the console publishes it: on the console's own origin. */
function page(server: ReturnType<typeof Bun.serve>, suffix = "") {
  return `${new URL(server.url).origin}/connect${suffix}`
}

/**
 * The console's own success shape, from apps/api/src/device/dto/device.dto.ts. The verification page
 * is built from the origin the request arrived on, because that is the only origin the client will
 * accept one from.
 */
function authorized(origin: string, overrides: Record<string, unknown> = {}) {
  return {
    deviceCode: DEVICE_CODE,
    userCode: "K7QM-2XR9",
    verificationUri: `${origin}/connect`,
    verificationUriComplete: `${origin}/connect?code=K7QM-2XR9`,
    expiresIn: 600,
    interval: 5,
    ...overrides,
  }
}

/** The console's own refusal shape: an RFC 8628 code in `error`, plus prose a client must ignore. */
function refused(status: number, error: string) {
  return json(status, { error, error_description: "prose for a person, not for a client", statusCode: status })
}

const DEVICE_CODE = "device-code-bearer-value"
const KEY = "test-rrk_a1b2c3d4_ZXhhbXBsZXNlY3JldA"
/** Nowhere near a live console, so an "unreachable" branch is genuinely unreachable. */
const DEAD_CONSOLE = "http://127.0.0.1:1/api/backend/v1"

const DEVICE: RedrobDeviceAuthorization = {
  deviceCode: DEVICE_CODE,
  userCode: "K7QM-2XR9",
  verificationUri: "https://console.example.test/connect",
  verificationUriComplete: "https://console.example.test/connect?code=K7QM-2XR9",
  expiresAt: 600_000,
  intervalMs: 5_000,
}

function options(server: ReturnType<typeof Bun.serve>, extra: RedrobAuthPluginOptions = {}): RedrobAuthPluginOptions {
  return {
    baseUrl: new URL("/api/backend/v1", server.url).toString(),
    openBrowser: async () => undefined,
    ...extra,
  }
}

/** No real waiting in the suite, a record of every backoff asked for, and a clock that advances. */
function clock(start = 0) {
  const slept: number[] = []
  let at = start
  return {
    slept,
    now: () => at,
    sleep: async (ms: number) => {
      slept.push(ms)
      at += ms
    },
  }
}

/** The plugin reads nothing off its input, so the suite hands it nothing. */
const NO_INPUT = {} as unknown as PluginInput

async function deviceMethod(extra: RedrobAuthPluginOptions = {}) {
  const hooks = await RedrobAuthPlugin(NO_INPUT, { openBrowser: async () => undefined, ...extra })
  const method = hooks.auth?.methods[0]
  if (method?.type !== "oauth") throw new Error("device connect must be the first, oauth, method")
  return method
}

describe("plugin.redrob device connect", () => {
  test("asks the console API that serves inference, and takes a page on that same origin", async () => {
    const seen: string[] = []
    const device = await requestDeviceAuthorization({
      fetchImpl: async (input) => {
        seen.push(input)
        return json(200, authorized("https://console.redrob.ai"))
      },
    })
    expect(seen).toEqual([`${CONSOLE_URL}/device/authorize`])
    expect(seen[0].startsWith("https://console.redrob.ai/")).toBe(true)
    expect(device.verificationUri).toBe("https://console.redrob.ai/connect")
  })

  describe("requestDeviceAuthorization", () => {
    test("asks /device/authorize for this product and maps the console's camelCase reply", async () => {
      const seen: Array<{ path: string; method: string; body: Record<string, unknown> }> = []
      const server = serveConsole((request, url, body) => {
        seen.push({ path: url.pathname, method: request.method, body })
        return json(200, authorized(url.origin))
      })
      try {
        const device = await requestDeviceAuthorization(options(server, { now: () => 1_000 }))
        expect(seen).toEqual([{ path: "/api/backend/v1/device/authorize", method: "POST", body: { product: "code" } }])
        expect(device.userCode).toBe("K7QM-2XR9")
        expect(device.verificationUri).toBe(page(server))
        expect(device.verificationUriComplete).toBe(page(server, "?code=K7QM-2XR9"))
        // Seconds on the wire, wall-clock milliseconds in the record, so a caller can count down
        // without trusting its own clock offset.
        expect(device.expiresAt).toBe(1_000 + 600_000)
        expect(device.intervalMs).toBe(5_000)
      } finally {
        await server.stop(true)
      }
    })

    test("falls back to the bare verification page when the console omits the prefilled one", async () => {
      const server = serveConsole((_request, url) => json(200, authorized(url.origin, { verificationUriComplete: "" })))
      try {
        const device = await requestDeviceAuthorization(options(server))
        expect(device.verificationUriComplete).toBe(page(server))
      } finally {
        await server.stop(true)
      }
    })

    test("substitutes the console's own deadline and interval when either is unusable", async () => {
      const server = serveConsole((_request, url) =>
        json(200, authorized(url.origin, { expiresIn: "NaN", interval: -5 })),
      )
      try {
        const device = await requestDeviceAuthorization(options(server, { now: () => 0 }))
        expect(device.expiresAt).toBe(600_000)
        expect(device.intervalMs).toBe(5_000)
      } finally {
        await server.stop(true)
      }
    })

    test("will not hold a code open for a deadline far past the console's own", async () => {
      const server = serveConsole((_request, url) => json(200, authorized(url.origin, { expiresIn: 86_400 })))
      try {
        const device = await requestDeviceAuthorization(options(server, { now: () => 0 }))
        expect(device.expiresAt).toBe(30 * 60_000)
      } finally {
        await server.stop(true)
      }
    })

    test("refuses a reply with no usable code rather than starting a loop that cannot finish", async () => {
      const server = serveConsole((_request, url) => json(200, authorized(url.origin, { userCode: "" })))
      try {
        await expect(requestDeviceAuthorization(options(server))).rejects.toThrow(
          "did not return a usable connection code",
        )
      } finally {
        await server.stop(true)
      }
    })

    test.each([
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url at all",
      "https://console.redrob.ai.evil.test/connect",
      "http://localhost:9/connect",
    ])("refuses %s as a verification page rather than opening it", async (verificationUri) => {
      const server = serveConsole((_request, url) =>
        json(200, authorized(url.origin, { verificationUri, verificationUriComplete: verificationUri })),
      )
      try {
        await expect(requestDeviceAuthorization(options(server))).rejects.toThrow(
          "did not return a usable connection code",
        )
      } finally {
        await server.stop(true)
      }
    })

    test("drops a prefilled page off the console's origin and keeps the bare one", async () => {
      const server = serveConsole((_request, url) =>
        json(200, authorized(url.origin, { verificationUriComplete: "https://evil.test/connect?code=K7QM-2XR9" })),
      )
      try {
        const device = await requestDeviceAuthorization(options(server))
        expect(device.verificationUriComplete).toBe(page(server))
      } finally {
        await server.stop(true)
      }
    })

    test("reports a refusal to start without echoing what the console said", async () => {
      const server = serveConsole(() => json(429, { message: "Too many attempts", retryAfter: 60 }))
      try {
        const error = await requestDeviceAuthorization(options(server)).catch((err: Error) => err)
        expect((error as Error).message).toBe("console.redrob.ai would not start the connection.")
      } finally {
        await server.stop(true)
      }
    })

    test("reports an unreachable console without leaking the address it tried", async () => {
      const error = await requestDeviceAuthorization({ baseUrl: DEAD_CONSOLE }).catch((err: Error) => err)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("Could not reach console.redrob.ai to start the connection.")
    })
  })

  describe("collectDeviceToken", () => {
    test("sends only the device code, and never the user code", async () => {
      const seen: Array<{ path: string; body: Record<string, unknown> }> = []
      const server = serveConsole((_request, url, body) => {
        seen.push({ path: url.pathname, body })
        return refused(400, "authorization_pending")
      })
      try {
        await collectDeviceToken(DEVICE, options(server))
        expect(seen).toEqual([{ path: "/api/backend/v1/device/token", body: { deviceCode: DEVICE_CODE } }])
      } finally {
        await server.stop(true)
      }
    })

    test.each([
      ["authorization_pending", 400, "pending"],
      ["slow_down", 400, "slow_down"],
      ["access_denied", 403, "denied"],
      ["expired_token", 400, "expired"],
      ["invalid_grant", 400, "failed"],
    ] as const)("maps the console's %s", async (error, status, expected) => {
      const server = serveConsole(() => refused(status, error))
      try {
        expect(await collectDeviceToken(DEVICE, options(server))).toMatchObject({ status: expected })
      } finally {
        await server.stop(true)
      }
    })

    test("carries the console's code, and nothing else, off a final refusal", async () => {
      const server = serveConsole(() => refused(400, "invalid_grant"))
      try {
        expect(await collectDeviceToken(DEVICE, options(server))).toEqual({ status: "failed", code: "invalid_grant" })
      } finally {
        await server.stop(true)
      }
    })

    test("falls back to the status when a refusal carries no code at all", async () => {
      const server = serveConsole(() => new Response("<html>gateway</html>", { status: 502 }))
      try {
        expect(await collectDeviceToken(DEVICE, options(server))).toEqual({ status: "failed", code: "http_502" })
      } finally {
        await server.stop(true)
      }
    })

    test("returns the key on success", async () => {
      const server = serveConsole(() => json(200, { apiKey: KEY, apiKeyId: "k1", product: "code" }))
      try {
        expect(await collectDeviceToken(DEVICE, options(server))).toEqual({ status: "connected", key: KEY })
      } finally {
        await server.stop(true)
      }
    })

    test("treats a 200 with no key as final, rather than as a key", async () => {
      const server = serveConsole(() => json(200, { apiKeyId: "k1" }))
      try {
        expect(await collectDeviceToken(DEVICE, options(server))).toEqual({ status: "failed", code: "missing_key" })
      } finally {
        await server.stop(true)
      }
    })

    test("a console it cannot reach is retryable, not a refusal", async () => {
      expect(await collectDeviceToken(DEVICE, { baseUrl: DEAD_CONSOLE })).toEqual({ status: "unreachable" })
    })
  })

  describe("pollDeviceToken", () => {
    test("waits through pending polls at the console's interval, then returns the key", async () => {
      let calls = 0
      const server = serveConsole(() => {
        calls += 1
        return calls < 3 ? refused(400, "authorization_pending") : json(200, { apiKey: KEY })
      })
      const time = clock()
      try {
        expect(await pollDeviceToken(DEVICE, options(server, time))).toEqual({ status: "connected", key: KEY })
        expect(calls).toBe(3)
        // The interval, plus the margin that stops the console answering slow_down on timer drift.
        expect(time.slept).toEqual([6_000, 6_000])
      } finally {
        await server.stop(true)
      }
    })

    test("backs off by five seconds per slow_down, as RFC 8628 requires, and keeps waiting", async () => {
      const answers: Array<string | undefined> = ["slow_down", "slow_down", "authorization_pending"]
      let calls = 0
      const server = serveConsole(() => {
        const answer = answers[calls]
        calls += 1
        return answer ? refused(400, answer) : json(200, { apiKey: KEY })
      })
      const time = clock()
      try {
        expect(await pollDeviceToken(DEVICE, options(server, time))).toEqual({ status: "connected", key: KEY })
        // 5s becomes 10s, then 15s, and the 15s is held for the pending poll that follows.
        expect(time.slept).toEqual([11_000, 16_000, 16_000])
      } finally {
        await server.stop(true)
      }
    })

    test("stops on a denial instead of polling on until the code expires", async () => {
      let calls = 0
      const server = serveConsole(() => {
        calls += 1
        return refused(403, "access_denied")
      })
      const time = clock()
      try {
        expect(await pollDeviceToken(DEVICE, options(server, time))).toEqual({ status: "denied" })
        expect(calls).toBe(1)
        expect(time.slept).toEqual([])
      } finally {
        await server.stop(true)
      }
    })

    test("stops when the console says the code expired", async () => {
      const server = serveConsole(() => refused(400, "expired_token"))
      try {
        expect(await pollDeviceToken(DEVICE, options(server, clock()))).toEqual({ status: "expired" })
      } finally {
        await server.stop(true)
      }
    })

    test("stops at its own deadline without asking the console at all", async () => {
      let calls = 0
      const server = serveConsole(() => {
        calls += 1
        return refused(400, "authorization_pending")
      })
      try {
        expect(await pollDeviceToken(DEVICE, options(server, clock(DEVICE.expiresAt)))).toEqual({ status: "expired" })
        expect(calls).toBe(0)
      } finally {
        await server.stop(true)
      }
    })

    test("clamps the last wait to the deadline rather than sleeping past it", async () => {
      const server = serveConsole(() => refused(400, "authorization_pending"))
      const time = clock(DEVICE.expiresAt - 8_000)
      try {
        expect(await pollDeviceToken(DEVICE, options(server, time))).toEqual({ status: "expired" })
        // A full interval fits with eight seconds left; the second wait is clipped to the two that
        // remain, and the loop then leaves rather than polling a code the console has dropped.
        expect(time.slept).toEqual([6_000, 2_000])
      } finally {
        await server.stop(true)
      }
    })

    test("never converts a final refusal into another attempt", async () => {
      let calls = 0
      const server = serveConsole(() => {
        calls += 1
        return refused(400, "invalid_grant")
      })
      try {
        expect(await pollDeviceToken(DEVICE, options(server, clock()))).toEqual({
          status: "failed",
          code: "invalid_grant",
        })
        expect(calls).toBe(1)
      } finally {
        await server.stop(true)
      }
    })

    test("retries a lost console, then gives up rather than waiting out the deadline in silence", async () => {
      const time = clock()
      expect(await pollDeviceToken(DEVICE, { baseUrl: DEAD_CONSOLE, ...time })).toEqual({
        status: "failed",
        code: "console_unreachable",
      })
      // Five attempts, and a wait after each of the first four.
      expect(time.slept.length).toBe(4)
    })

    test("a console that comes back clears the run of unreachable polls", async () => {
      /**
       * Eight dead polls with one live pending poll in the middle. Without the reset the run would
       * reach five and the attempt would be abandoned; with it, neither side of the gap does.
       */
      const reachable = [false, false, false, false, true, false, false, false, false, true]
      let attempt = 0
      const server = serveConsole(() => refused(400, "authorization_pending"))
      const live = new URL("/api/backend/v1", server.url).toString()
      const time = clock()
      try {
        const outcome = await pollDeviceToken(DEVICE, {
          ...time,
          fetchImpl: async (input, init) => {
            const index = attempt++
            if (!reachable[index]) throw new Error("ECONNREFUSED")
            if (index === 9) return json(200, { apiKey: KEY })
            return fetch(input.replace(DEAD_CONSOLE, live), init)
          },
          baseUrl: DEAD_CONSOLE,
        })
        expect(outcome).toEqual({ status: "connected", key: KEY })
        expect(attempt).toBe(10)
      } finally {
        await server.stop(true)
      }
    })

    test("hands the poll the attempt's signal, so cancelling drops the request in flight", async () => {
      const controller = new AbortController()
      let handed: AbortSignal | null | undefined
      const outcome = await pollDeviceToken(DEVICE, {
        ...clock(),
        signal: controller.signal,
        fetchImpl: async (_input, init) => {
          handed = init?.signal
          controller.abort()
          // What a real fetch does once the signal it was given is aborted.
          throw new Error("The operation was aborted.")
        },
      })
      // Cancelled, not unreachable: an abort is not a console that could not be reached.
      expect(handed).toBe(controller.signal)
      expect(outcome).toEqual({ status: "cancelled" })
    })

    test("an aborted attempt is cancelled rather than left to collect a key nobody is waiting for", async () => {
      let calls = 0
      const server = serveConsole(() => {
        calls += 1
        return refused(400, "authorization_pending")
      })
      const controller = new AbortController()
      try {
        const outcome = await pollDeviceToken(
          DEVICE,
          options(server, {
            now: () => 0,
            sleep: async () => controller.abort(),
            signal: controller.signal,
          }),
        )
        expect(outcome).toEqual({ status: "cancelled" })
        expect(calls).toBe(1)
      } finally {
        await server.stop(true)
      }
    })
  })

  describe("the auth hook", () => {
    test("registers device connect first and keeps the pasted key as a second way in", async () => {
      const hooks = await RedrobAuthPlugin(NO_INPUT)
      expect(hooks.auth?.provider).toBe("redrob")
      expect(hooks.auth?.methods.map((method) => ({ type: method.type, label: method.label }))).toEqual([
        { type: "oauth", label: "Connect Redrob" },
        { type: "api", label: "Paste an API key from console.redrob.ai" },
      ])
    })

    test("no label a person reads carries an em dash", async () => {
      const hooks = await RedrobAuthPlugin(NO_INPUT)
      for (const method of hooks.auth?.methods ?? []) expect(method.label).not.toMatch(/[\u2014\u2013]/)
    })

    test("shows the code and the page, and hands the console's key back for ordinary key storage", async () => {
      let calls = 0
      const server = serveConsole((_request, url) => {
        calls += 1
        if (url.pathname.endsWith("/device/authorize")) return json(200, authorized(url.origin))
        return calls === 2 ? refused(400, "authorization_pending") : json(200, { apiKey: KEY })
      })
      const opened: string[] = []
      try {
        const method = await deviceMethod(
          options(server, { ...clock(), openBrowser: async (url) => void opened.push(url) }),
        )
        const authorization = await method.authorize()
        expect(authorization.method).toBe("auto")
        expect(authorization.url).toBe(page(server, "?code=K7QM-2XR9"))
        expect(authorization.instructions).toContain("K7QM-2XR9")
        // The dialog's copy binding lifts the code out of the instructions with exactly this shape.
        expect(authorization.instructions).toMatch(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)
        expect(authorization.instructions).toContain("adds no credit")
        expect(authorization.instructions).not.toMatch(/[\u2014\u2013]/)
        // Opened through the same platform helper the rest of the CLI opens URLs with.
        expect(opened).toEqual([page(server, "?code=K7QM-2XR9")])

        if (authorization.method !== "auto") throw new Error("expected the auto method")
        // A success carrying `key` is what ProviderAuth.callback writes through
        // Auth.set("redrob", { type: "api", key }), which is where a pasted key already goes.
        expect(await authorization.callback()).toEqual({ type: "success", key: KEY })
        expect(calls).toBe(3)
      } finally {
        await server.stop(true)
      }
    })

    test("neither the device code nor the key reaches anything a caller can show", async () => {
      const server = serveConsole((_request, url) =>
        url.pathname.endsWith("/device/authorize") ? json(200, authorized(url.origin)) : json(200, { apiKey: KEY }),
      )
      try {
        const method = await deviceMethod(options(server, clock()))
        const authorization = await method.authorize()

        // Everything a UI is handed before the key exists. The device code is the bearer of the
        // pending connection, so none of it may carry the code either.
        const shown = JSON.stringify(authorization)
        expect(shown).not.toContain(DEVICE_CODE)
        expect(shown).not.toContain(KEY)
        expect(shown).not.toContain("rrk_")

        if (authorization.method !== "auto") throw new Error("expected the auto method")
        // The key appears in exactly one value: the success the caller stores.
        expect(await authorization.callback()).toEqual({ type: "success", key: KEY })
      } finally {
        await server.stop(true)
      }
    })

    test("nothing in the flow is written to the terminal", async () => {
      const server = serveConsole((_request, url) =>
        url.pathname.endsWith("/device/authorize") ? json(200, authorized(url.origin)) : json(200, { apiKey: KEY }),
      )
      const written: string[] = []
      const stdout = process.stdout.write
      const stderr = process.stderr.write
      // The one place the suite touches a global, because "printed nothing" is only observable at
      // the streams the plugin would have printed to.
      const capture = ((chunk: unknown) => {
        written.push(String(chunk))
        return true
      }) as typeof process.stdout.write
      process.stdout.write = capture
      process.stderr.write = capture
      try {
        const method = await deviceMethod(options(server, clock()))
        const authorization = await method.authorize()
        if (authorization.method !== "auto") throw new Error("expected the auto method")
        await authorization.callback()
      } finally {
        process.stdout.write = stdout
        process.stderr.write = stderr
        await server.stop(true)
      }
      expect(written.join("")).toBe("")
    })

    test("a refusal is reported as a failure, never as a key", async () => {
      const server = serveConsole((_request, url) =>
        url.pathname.endsWith("/device/authorize") ? json(200, authorized(url.origin)) : refused(403, "access_denied"),
      )
      try {
        const method = await deviceMethod(options(server, clock()))
        const authorization = await method.authorize()
        if (authorization.method !== "auto") throw new Error("expected the auto method")
        expect(await authorization.callback()).toEqual({ type: "failed" })
      } finally {
        await server.stop(true)
      }
    })

    test("a browser that will not open does not stop the connection", async () => {
      const server = serveConsole((_request, url) =>
        url.pathname.endsWith("/device/authorize") ? json(200, authorized(url.origin)) : json(200, { apiKey: KEY }),
      )
      try {
        const method = await deviceMethod(
          options(server, {
            ...clock(),
            openBrowser: async () => {
              throw new Error("spawn xdg-open ENOENT")
            },
          }),
        )
        const authorization = await method.authorize()
        expect(authorization.url).toBe(page(server, "?code=K7QM-2XR9"))
        if (authorization.method !== "auto") throw new Error("expected the auto method")
        expect(await authorization.callback()).toEqual({ type: "success", key: KEY })
      } finally {
        await server.stop(true)
      }
    })

    test("starting a second connection abandons the first, so one code cannot be collected twice", async () => {
      const server = serveConsole((_request, url) =>
        url.pathname.endsWith("/device/authorize")
          ? json(200, authorized(url.origin))
          : refused(400, "authorization_pending"),
      )
      try {
        const method = await deviceMethod(options(server, clock()))
        const first = await method.authorize()
        if (first.method !== "auto") throw new Error("expected the auto method")
        // Held rather than awaited: the first loop is still polling when the second start lands.
        const abandoned = first.callback()
        await method.authorize()
        expect(await abandoned).toEqual({ type: "failed" })
      } finally {
        await server.stop(true)
      }
    })
  })
})
