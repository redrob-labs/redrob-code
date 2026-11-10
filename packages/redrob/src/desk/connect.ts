/**
 * `redrob desk connect rc_...` (the install script's `--connect`): one pasted line connects a
 * server to the person's Redrob Chat (code-work design 4.2).
 *
 * The `rc_...` code is made by the web's connect card, works once and lasts 10 minutes. With it
 * the engine tells the chat API how far it got, so the card can do the person's part:
 *
 *   1. the engine starts the usual redrob-auth device sign-in (`POST /desk/login`) and reports the
 *      user code (`step: "login"`); the card opens `<issuer>/device?user_code=...` for one click;
 *   2. once signed in, the desk is turned on (`step: "signed_in"`); the card's browser pairs with
 *      this machine through the relay, which leaves a pending request with a 6-digit code;
 *   3. the card hands that code to the chat API, the engine reads it (`GET`) and approves exactly
 *      that pending web request (`step: "paired"`).
 *
 * The rc_ code is the only credential on these calls: it proves the card that made it, and the
 * engine never sends a token of its own. Every call is the chat API's
 * `/runner/connect/:token` (POST a step, GET the pairing code).
 */
import os from "node:os"

export const TOKEN = /^rc_[A-Za-z0-9_-]{8,128}$/

export const isToken = (value: unknown): value is string => typeof value === "string" && TOKEN.test(value)

/** How long the whole connect may take: the rc_ code's own life. */
export const CONNECT_MS = 10 * 60_000
const POLL_MS = 2_000

export type ConnectMachine = { readonly id: string; readonly name: string; readonly os: string; readonly arch: string }

/** One `POST /runner/connect/:token` body. */
export type Step =
  | {
      readonly step: "login"
      readonly machine: ConnectMachine
      readonly userCode: string
      readonly verificationUri: string
      readonly expiresAt: number
    }
  | { readonly step: "signed_in"; readonly machine: ConnectMachine; readonly email?: string }
  | { readonly step: "paired"; readonly machine: ConnectMachine; readonly device: { readonly id: string; readonly name: string } }
  | { readonly step: "failed"; readonly machine: ConnectMachine; readonly error: string }

/** The rc_ code is unknown, used or expired: nothing more will happen on the web side. */
export class GoneError extends Error {}

export type ConnectApi = {
  report(step: Step): Promise<void>
  /** The pairing code the card's browser shows, once it has one. */
  poll(): Promise<{ pairCode?: string }>
}

/** The chat API side, over plain fetch with the rc_ code in the path. */
export function chatConnectApi(chatApi: string, token: string): ConnectApi {
  const url = `${chatApi.replace(/\/+$/, "")}/runner/connect/${encodeURIComponent(token)}`
  const check = async (response: Response) => {
    if (response.status === 404 || response.status === 410) throw new GoneError("this connect code is used or expired")
    if (!response.ok) throw new Error(`chat API ${response.status}`)
    return response
  }
  return {
    report: async (step) => {
      await check(
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(step),
          signal: AbortSignal.timeout(20_000),
        }),
      )
    },
    poll: async () => {
      const response = await check(
        await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) }),
      )
      const body = (await response.json().catch(() => ({}))) as { pairCode?: unknown }
      return typeof body.pairCode === "string" && /^\d{6}$/.test(body.pairCode) ? { pairCode: body.pairCode } : {}
    },
  }
}

type Login = { userCode: string; verificationUriComplete: string; expiresAt: number }
type Status = {
  enabled: boolean
  signedIn: boolean
  account?: { email: string }
  login?: Login
  pending: { code: string; name: string; kind: "phone" | "web"; expiresAt: number }[]
}

/** The running engine's local `/desk/*` routes, as `redrob desk` calls them. */
export type DeskLocal = {
  status(): Promise<Status>
  login(): Promise<Login>
  enable(): Promise<void>
  approve(code: string): Promise<{ id: string; name: string }>
}

export type ConnectOptions = {
  readonly machine: ConnectMachine
  readonly say: (line: string) => void
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

export const thisMachine = (id: string, name = os.hostname()): ConnectMachine => ({
  id,
  name,
  os: process.platform,
  arch: process.arch,
})

/** Sign in, turn the desk on and approve the card's browser. Resolves with the approved device. */
export async function connect(
  api: ConnectApi,
  local: DeskLocal,
  options: ConnectOptions,
): Promise<{ id: string; name: string }> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + CONNECT_MS
  const { machine, say } = options
  try {
    let status = await local.status()
    if (!status.signedIn) {
      const login = status.login ?? (await local.login())
      await api.report({
        step: "login",
        machine,
        userCode: login.userCode,
        verificationUri: login.verificationUriComplete,
        expiresAt: login.expiresAt,
      })
      say("Approve this machine in the browser where you made the connect line.")
      say(`(Or open ${login.verificationUriComplete} and confirm the code ${login.userCode}.)`)
      while (!status.signedIn) {
        if (now() > Math.min(login.expiresAt, deadline)) throw new Error("the sign-in code expired")
        await sleep(POLL_MS)
        status = await local.status()
        if (!status.signedIn && !status.login) throw new Error("the sign-in did not finish")
      }
    }
    say(`signed in${status.account ? ` as ${status.account.email}` : ""}`)
    if (!status.enabled) await local.enable()
    await api.report({ step: "signed_in", machine, ...(status.account ? { email: status.account.email } : {}) })
    say("Waiting for the browser to connect...")
    while (now() < deadline) {
      const { pairCode } = await api.poll()
      if (pairCode) {
        const pending = (await local.status()).pending.find((request) => request.code === pairCode && request.kind === "web")
        if (pending) {
          const device = await local.approve(pairCode)
          await api.report({ step: "paired", machine, device })
          say(`connected: "${device.name}" can use this machine`)
          return device
        }
      }
      await sleep(POLL_MS)
    }
    throw new Error("the browser did not connect in time")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!(error instanceof GoneError)) await api.report({ step: "failed", machine, error: message }).catch(() => undefined)
    throw error
  }
}
