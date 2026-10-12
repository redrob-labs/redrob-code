import type { SignInProgress } from "../shared/bridge"

/**
 * Console sign-in, by the RFC 8628 device flow the Console already serves for every Redrob product.
 *
 *   POST {console}/device/authorize {product:"code"} -> deviceCode, userCode, verificationUriComplete
 *   the person approves in the browser, choosing the workspace
 *   POST {console}/device/token {deviceCode}         -> apiKey (exactly once)
 *
 * The key goes from the Console response straight into the engine's credential store
 * (`POST /api/integration/redrob/connect/key`) and is never handed to the interface or written by the
 * app. That is the single-store rule from docs/PROVIDER-AUTH.md: the engine is the source of truth, and
 * the CLI on the same machine sees the same sign-in.
 */

export const DEFAULT_CONSOLE_URL = "https://console.redrob.ai/api/backend/v1"

export function consoleUrl(env: Record<string, string | undefined>) {
  return (env["REDROB_CONSOLE_URL"]?.trim() || DEFAULT_CONSOLE_URL).replace(/\/+$/, "")
}

type Authorization = {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

type Token = { apiKey: string; apiKeyName: string; accountName: string }

export type SignInDeps = {
  consoleUrl: string
  fetch: typeof globalThis.fetch
  openExternal: (url: string) => Promise<void>
  /** Stores the key in the engine. Only this function ever sees it. */
  storeKey: (key: string, label: string) => Promise<void>
  onProgress: (progress: SignInProgress) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** The RFC 8628 code from a failed poll, wherever this deployment put it. */
export function deviceError(body: unknown): string | null {
  if (!body || typeof body !== "object") return null
  const record = body as Record<string, unknown>
  if (typeof record["error"] === "string") return record["error"]
  const nested = record["error"]
  if (nested && typeof nested === "object") {
    const code = (nested as Record<string, unknown>)["code"]
    if (typeof code === "string") return code
  }
  if (typeof record["code"] === "string") return record["code"]
  return null
}

export function createSignIn(deps: SignInDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const now = deps.now ?? Date.now
  let run = 0

  async function post(path: string, body: unknown) {
    const response = await deps.fetch(`${deps.consoleUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const json = (await response.json().catch(() => null)) as unknown
    return { response, json }
  }

  async function start() {
    const mine = ++run
    try {
      const { response, json } = await post("/device/authorize", { product: "code" })
      if (!response.ok) throw new Error(`The Console refused to start sign-in (${response.status}).`)
      const auth = json as Authorization
      const expiresAt = now() + auth.expiresIn * 1000
      deps.onProgress({
        status: "waiting",
        userCode: auth.userCode,
        verificationUri: auth.verificationUriComplete || auth.verificationUri,
        expiresAt,
      })
      await deps.openExternal(auth.verificationUriComplete || auth.verificationUri)

      let interval = Math.max(1, auth.interval) * 1000
      while (mine === run) {
        await sleep(interval)
        if (mine !== run) return
        if (now() > expiresAt) return deps.onProgress({ status: "expired" })
        const poll = await post("/device/token", { deviceCode: auth.deviceCode })
        if (poll.response.ok) {
          const token = poll.json as Token
          await deps.storeKey(token.apiKey, token.apiKeyName)
          return deps.onProgress({ status: "connected", accountName: token.accountName, keyName: token.apiKeyName })
        }
        const code = deviceError(poll.json)
        if (code === "authorization_pending") continue
        if (code === "slow_down") {
          interval += 5_000
          continue
        }
        if (code === "access_denied") return deps.onProgress({ status: "denied" })
        if (code === "expired_token" || code === "invalid_grant") return deps.onProgress({ status: "expired" })
        throw new Error(`Sign-in failed (${poll.response.status}${code ? `, ${code}` : ""}).`)
      }
    } catch (error) {
      if (mine !== run) return
      deps.onProgress({ status: "failed", message: error instanceof Error ? error.message : String(error) })
    }
  }

  function cancel() {
    run++
    deps.onProgress({ status: "cancelled" })
  }

  return { start, cancel }
}
