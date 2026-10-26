/**
 * Sign-in for the desk relay, and the two chat API calls the daemon makes
 * (redrob-mobile `docs/desk-relay.md`, section 1).
 *
 * The chat API's `/mobile/*` routes sit behind its user JWT guard, which takes redrob-auth tokens
 * of the `REDROB_AUTH_DESKTOP_CLIENTS` clients. The Console key the `redrob` provider spends (and
 * sharing sends) is not one of those, so the daemon signs in as the public `redrob-code` desktop
 * client: RFC 8628 device grant once (`POST /desk/login` from the launcher, or `redrob desk login`),
 * `refresh_token` grant after that.
 * Only the refresh token is kept, in the secret store (`~/.redrob/channels/secrets.json`, 0600)
 * under `desk.refreshToken`. redrob-auth rotates it on every refresh, so every refresh writes the
 * new one back before the access token is used.
 */
import { Flag } from "@redrob-code/core/flag/flag"
import { DEFAULT_CHAT_API_URL } from "@/share/share-next"

export const CLIENT_ID = "redrob-code"
export const SCOPE = "openid profile email"
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

const PROD_ISSUER = "https://auth.redrob.io"
const DEV_ISSUER = "https://devauth.redrob.io"

/** Where the daemon signs in and which chat API it asks for tickets and pushes. */
export function endpoints(env: NodeJS.ProcessEnv = process.env): { issuer: string; chatApi: string } {
  // Same chat API sharing uses: `REDROB_CHAT_API_URL`, else production.
  const chatApi = (Flag.REDROB_CHAT_API_URL ?? DEFAULT_CHAT_API_URL).replace(/\/+$/, "")
  const dev = new URL(chatApi).hostname.split(/[.-]/).includes("dev")
  const issuer = (env.REDROB_AUTH_ISSUER?.trim() || (dev ? DEV_ISSUER : PROD_ISSUER)).replace(/\/+$/, "")
  return { issuer, chatApi }
}

export type TokenSet = {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt: number
  /** From the `id_token`, when the issuer sent one. Shown by `GET /desk/status`. */
  readonly email?: string
}

/** The `email` claim of an ID token. Read only for display; the token came straight from the issuer over TLS. */
function emailOf(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined
  const part = idToken.split(".")[1]
  if (!part) return undefined
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { email?: unknown }
    return typeof claims.email === "string" && claims.email ? claims.email : undefined
  } catch {
    return undefined
  }
}

export type DeviceAuthorization = {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUriComplete: string
  readonly expiresAt: number
  readonly intervalMs: number
}

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ? `${code}: ${message}` : code)
  }
}

async function post(issuer: string, path: string, form: Record<string, string>) {
  const response = await fetch(`${issuer}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: response.ok, status: response.status, body }
}

function tokens(body: Record<string, unknown>, now: number): TokenSet {
  const accessToken = typeof body.access_token === "string" ? body.access_token : ""
  if (!accessToken) throw new AuthError("invalid_response", "no access_token in the token response")
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600
  const email = emailOf(body.id_token)
  return {
    accessToken,
    ...(email ? { email } : {}),
    ...(typeof body.refresh_token === "string" && body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    expiresAt: now + expiresIn * 1000,
  }
}

function oauthError(body: Record<string, unknown>, status: number): AuthError {
  const code = typeof body.error === "string" ? body.error : `http_${status}`
  return new AuthError(code, typeof body.error_description === "string" ? body.error_description : undefined)
}

export async function startDeviceLogin(issuer: string): Promise<DeviceAuthorization> {
  const result = await post(issuer, "/oauth/device_authorization", { client_id: CLIENT_ID, scope: SCOPE })
  if (!result.ok) throw oauthError(result.body, result.status)
  const b = result.body
  const deviceCode = typeof b.device_code === "string" ? b.device_code : ""
  const userCode = typeof b.user_code === "string" ? b.user_code : ""
  const verificationUri = typeof b.verification_uri === "string" ? b.verification_uri : ""
  if (!deviceCode || !userCode || !verificationUri) throw new AuthError("invalid_response", "incomplete device authorization")
  return {
    deviceCode,
    userCode,
    verificationUriComplete: typeof b.verification_uri_complete === "string" ? b.verification_uri_complete : verificationUri,
    expiresAt: Date.now() + (typeof b.expires_in === "number" ? b.expires_in : 600) * 1000,
    intervalMs: (typeof b.interval === "number" && b.interval > 0 ? b.interval : 5) * 1000,
  }
}

/** Poll the token endpoint until the person approves, denies, or the code expires. */
export async function finishDeviceLogin(issuer: string, device: DeviceAuthorization): Promise<TokenSet> {
  let interval = device.intervalMs
  while (Date.now() < device.expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, interval))
    const result = await post(issuer, "/oauth/token", {
      grant_type: DEVICE_GRANT,
      device_code: device.deviceCode,
      client_id: CLIENT_ID,
    }).catch(() => undefined)
    if (!result) continue
    if (result.ok) return tokens(result.body, Date.now())
    const error = oauthError(result.body, result.status)
    if (error.code === "authorization_pending") continue
    if (error.code === "slow_down") {
      interval += 5_000
      continue
    }
    throw error
  }
  throw new AuthError("expired_token", "the sign-in code expired")
}

export type TokenStore = {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
}

/**
 * Hands out a valid access token, refreshing from the stored refresh token near expiry. Concurrent
 * callers share one refresh, since a rotated refresh token can only be spent once.
 */
export class AccessTokens {
  private current?: TokenSet
  private inflight?: Promise<TokenSet>

  constructor(
    private readonly issuer: string,
    private readonly store: TokenStore,
  ) {}

  async get(): Promise<string> {
    if (this.current && this.current.expiresAt - 60_000 > Date.now()) return this.current.accessToken
    return (await this.renew()).accessToken
  }

  invalidate(): void {
    this.current = undefined
  }

  private renew(): Promise<TokenSet> {
    if (!this.inflight) {
      this.inflight = (async () => {
        const stored = await this.store.get("refreshToken")
        if (!stored) throw new AuthError("signed_out", "run: redrob desk login")
        const result = await post(this.issuer, "/oauth/token", {
          grant_type: "refresh_token",
          refresh_token: stored,
          client_id: CLIENT_ID,
        })
        if (!result.ok) throw oauthError(result.body, result.status)
        const next = tokens(result.body, Date.now())
        if (next.refreshToken) await this.store.set("refreshToken", next.refreshToken)
        if (next.email) await this.store.set("email", next.email)
        this.current = next
        return next
      })().finally(() => {
        this.inflight = undefined
      })
    }
    return this.inflight
  }
}

/** `POST /mobile/relay-ticket` answer: the Design ticket DTO plus the room. */
export type RelayTicket = {
  readonly url: string
  readonly ticket: string
  readonly expiresAt: string
  readonly role: string
  readonly peerId: string
  readonly room: string
}

export class ChatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** The chat API calls the daemon makes, with the redrob-auth bearer. */
export class ChatApi {
  constructor(
    private readonly base: string,
    private readonly tokens: AccessTokens,
  ) {}

  private async post(path: string, body: unknown): Promise<Response> {
    const send = async () =>
      fetch(`${this.base}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this.tokens.get()}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      })
    let response = await send()
    if (response.status === 401) {
      this.tokens.invalidate()
      response = await send()
    }
    if (!response.ok) throw new ChatError(response.status, `${path}: ${response.status}`)
    return response
  }

  async relayTicket(): Promise<RelayTicket> {
    return (await (await this.post("/mobile/relay-ticket", { as: "desk" })).json()) as RelayTicket
  }

  async notify(kind: "done" | "approval", sessionId: string, title?: string): Promise<void> {
    await this.post("/mobile/notify", { kind, sessionId, ...(title ? { title: title.slice(0, 120) } : {}) })
  }
}
