import type { Hooks, PluginInput } from "@redrob-code/plugin"
import { CONSOLE_URL } from "@redrob-code/core/plugin/provider/redrob-constants"
import { InstallationVersion } from "@redrob-code/core/installation/version"
import open from "open"

/**
 * Connecting Redrob Code to a console workspace without anyone handling the key.
 *
 * The console implements RFC 8628's device authorization grant. This module asks it for a code,
 * shows the code and the verification page, and polls until the console hands back an ordinary
 * workspace API key. The key is returned exactly once, to the caller: ProviderAuth.callback writes
 * it through Auth.set("redrob", { type: "api", key }), which is where a pasted REDROB_API_KEY
 * already goes. Nothing here persists anything, and there is no second credential store.
 *
 * The device code is the bearer of the pending connection, so it stays in this module: it is never
 * returned to a caller, put in an error, or written anywhere. Nothing here logs, and a refusal is
 * reported as its RFC 8628 error code alone, because a body echo is how a credential ends up in a
 * terminal scrollback. Connecting mints no credit; the console issues a key and only a key.
 */

/** Ten minutes and five seconds are the console's own deadline and interval, held as fallbacks. */
const FALLBACK_EXPIRES_MS = 10 * 60_000
const FALLBACK_INTERVAL_MS = 5_000
const MIN_INTERVAL_MS = 1_000
/** A deadline read off the network cannot keep an approved code collectable for longer than this. */
const MAX_EXPIRES_MS = 30 * 60_000
/** RFC 8628 section 3.5: on `slow_down` the client raises its interval by at least five seconds. */
const SLOW_DOWN_INCREMENT_MS = 5_000
/**
 * The console resets its interval window on every poll, including the ones it refuses, so a client
 * that polls at exactly `interval` earns `slow_down` on the first tick of timer drift and then never
 * escapes it. A second of headroom keeps the loop on the pending branch.
 */
const POLL_SAFETY_MARGIN_MS = 1_000
/**
 * A lost network is worth retrying, unlike a refusal, but not for the full ten minutes in silence.
 * After this many consecutive failures to reach the console the attempt ends and the user starts
 * again, which is the only useful thing left to do.
 */
const MAX_UNREACHABLE_POLLS = 5

export interface RedrobAuthPluginOptions {
  baseUrl?: string
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  signal?: AbortSignal
  /** Off in the suites, so a test run never spawns a browser. */
  openBrowser?: (url: string) => Promise<unknown>
}

/** What one round trip to `/device/authorize` yields. Carries no key. */
export interface RedrobDeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresAt: number
  intervalMs: number
}

/**
 * Every way a single poll can end. `pending` and `slow_down` mean keep waiting, `unreachable` means
 * the console could not be reached and the caller may try again, and the rest are final.
 */
export type RedrobDevicePoll =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "connected"; key: string }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "unreachable" }
  | { status: "failed"; code: string }

/** Every way the whole loop can end. `pending` and `slow_down` are not outcomes, only waits. */
export type RedrobDeviceOutcome =
  | { status: "connected"; key: string }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "cancelled" }
  | { status: "failed"; code: string }

export async function requestDeviceAuthorization(
  options: RedrobAuthPluginOptions = {},
): Promise<RedrobDeviceAuthorization> {
  const now = options.now ?? (() => Date.now())
  const response = await request(options, "/device/authorize", { product: "code" }).catch(() => {
    throw new Error("Could not reach console.redrob.ai to start the connection.")
  })
  if (!response.ok) throw new Error("console.redrob.ai would not start the connection.")

  const body = await readJson(response)
  const deviceCode = text(body.deviceCode)
  const userCode = text(body.userCode)
  const verificationUri = consolePage(body.verificationUri, options)
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error("console.redrob.ai did not return a usable connection code.")
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    // The prefilled form is a convenience. Without it the bare page plus a typed code is the same
    // flow, so a console that omits it falls back rather than failing.
    verificationUriComplete: consolePage(body.verificationUriComplete, options) || verificationUri,
    expiresAt: now() + Math.min(positiveSecondsToMs(body.expiresIn, FALLBACK_EXPIRES_MS), MAX_EXPIRES_MS),
    intervalMs: Math.max(positiveSecondsToMs(body.interval, FALLBACK_INTERVAL_MS), MIN_INTERVAL_MS),
  }
}

/**
 * One poll. Split out from the loop so each console answer is observable on its own: the mapping
 * from an RFC 8628 code to "keep waiting" or "stop" is the part that has to be right.
 */
export async function collectDeviceToken(
  device: Pick<RedrobDeviceAuthorization, "deviceCode">,
  options: RedrobAuthPluginOptions = {},
): Promise<RedrobDevicePoll> {
  const response = await request(options, "/device/token", { deviceCode: device.deviceCode }).catch(() => undefined)
  if (!response) return { status: "unreachable" }

  const body = await readJson(response)

  if (response.ok) {
    const key = text(body.apiKey)
    if (!key) return { status: "failed", code: "missing_key" }
    return { status: "connected", key }
  }

  const code = text(body.error)
  if (code === "authorization_pending") return { status: "pending" }
  if (code === "slow_down") return { status: "slow_down" }
  if (code === "access_denied") return { status: "denied" }
  if (code === "expired_token") return { status: "expired" }

  // Anything else, including invalid_grant and a console that answered with no code at all, is
  // final: the console has said this device code will never produce a key, and polling on would
  // only hide that.
  return { status: "failed", code: code || `http_${response.status}` }
}

export async function pollDeviceToken(
  device: RedrobDeviceAuthorization,
  options: RedrobAuthPluginOptions = {},
): Promise<RedrobDeviceOutcome> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? (() => Date.now())
  let intervalMs = device.intervalMs
  let unreachable = 0

  while (!options.signal?.aborted) {
    if (now() >= device.expiresAt) return { status: "expired" }

    const poll = await collectDeviceToken(device, options)
    // Checked before the answer is used, so a cancelled attempt cannot hand back a key.
    if (options.signal?.aborted) break
    if (poll.status !== "pending" && poll.status !== "slow_down" && poll.status !== "unreachable") return poll

    // Any answer at all clears the run: only consecutive failures to reach the console count.
    unreachable = poll.status === "unreachable" ? unreachable + 1 : 0
    if (unreachable >= MAX_UNREACHABLE_POLLS) return { status: "failed", code: "console_unreachable" }
    if (poll.status === "slow_down") intervalMs += SLOW_DOWN_INCREMENT_MS

    const remaining = device.expiresAt - now()
    if (remaining <= 0) return { status: "expired" }
    await sleep(Math.min(intervalMs + POLL_SAFETY_MARGIN_MS, remaining))
  }

  return { status: "cancelled" }
}

/**
 * The `redrob` credential, offered two ways.
 *
 * Device connect is first because it is the one a person can finish without handling a secret. The
 * pasted key stays as a second method rather than being replaced: it is what works when the console
 * is unreachable from this machine, when a key is issued out of band, and when someone is scripting
 * a container.
 */
export async function RedrobAuthPlugin(_input: PluginInput, options: RedrobAuthPluginOptions = {}): Promise<Hooks> {
  /**
   * One attempt at a time. Starting a connect abandons the previous poll loop, because ProviderAuth
   * keeps a single pending authorization per provider and a loop still polling for a code nobody is
   * looking at is a loop that can collect a key nobody asked for.
   */
  let inflight: AbortController | undefined

  return {
    auth: {
      provider: "redrob",
      methods: [
        {
          type: "oauth",
          label: "Connect Redrob",
          async authorize() {
            inflight?.abort()
            const controller = new AbortController()
            inflight = controller

            const device = await requestDeviceAuthorization(options)

            // Best effort, and never awaited for success: the code and the page are on screen either
            // way, so a machine with no browser, no display, or a console approved from a phone
            // loses nothing. Same platform helper the rest of the CLI opens URLs with.
            const openImpl = options.openBrowser ?? ((url: string) => open(url))
            await openImpl(device.verificationUriComplete).catch(() => undefined)

            return {
              url: device.verificationUriComplete,
              instructions: `Enter code ${device.userCode} on the console to connect this machine. Connecting issues a workspace API key. It adds no credit.`,
              method: "auto" as const,
              async callback() {
                const outcome = await pollDeviceToken(device, { ...options, signal: controller.signal })
                if (outcome.status !== "connected") return { type: "failed" as const }
                return { type: "success" as const, key: outcome.key }
              },
            }
          },
        },
        {
          type: "api",
          label: "Paste an API key from console.redrob.ai",
        },
      ],
    },
  }
}

/** The console's machine API, shared with the inference calls, so a device flow and a key agree. */
function baseUrl(options: RedrobAuthPluginOptions) {
  return (options.baseUrl ?? CONSOLE_URL).replace(/\/+$/, "")
}

function request(options: RedrobAuthPluginOptions, path: string, body: Record<string, string>) {
  const fetchImpl = options.fetchImpl ?? fetch
  return fetchImpl(`${baseUrl(options)}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": `redrob/${InstallationVersion}`,
    },
    body: JSON.stringify(body),
    // A cancelled attempt drops the request in flight, so a key can never arrive in a body nobody
    // is reading.
    signal: options.signal,
  })
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => undefined)
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * A page on the console this client already talks to, or nothing. The verification URL comes off the
 * network and is both rendered as a link and handed to the platform opener, so a foreign host, a
 * `file:` path or a custom scheme reaching either of those would be this module acting on a
 * stranger's word. Anything off that origin is dropped, which fails the connection rather than
 * opening it.
 */
function consolePage(value: unknown, options: RedrobAuthPluginOptions): string {
  const raw = text(value)
  const page = URL.parse(raw)
  const api = URL.parse(baseUrl(options))
  if (!page || !api) return ""
  return page.origin === api.origin ? raw : ""
}

/**
 * Normalises a seconds field to milliseconds. Guards the loop against `NaN`, `null` and negatives
 * from a misbehaving console: `NaN` is a number, so it would pass `??`, reach `setTimeout` as 0, and
 * busy-loop until the deadline.
 */
function positiveSecondsToMs(value: unknown, fallbackMs: number): number {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallbackMs
}
