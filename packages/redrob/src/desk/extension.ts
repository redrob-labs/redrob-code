/**
 * The engine as a caller of the Redrob browser extension (redrob-extension `docs/remote-control.md`).
 *
 * The extension already takes the desk role in room `desk:<user id>` and answers paired devices with
 * the route set of its `src/remote/forward.ts`. This is the device side of that same handshake, as
 * Redrob chat's web page does it (`apps/web/lib/desk/relay-client.ts`): one more socket in the room,
 * `desk.hello` (kind "web") to the browser peer, the six-digit pairing the person allows once in
 * Chrome, then `{t:"req"}` / `{t:"res"}` in sealed `desk.msg` frames. No new server, route or
 * entry point on either side. The room is the account, so a browser found here is signed in to the
 * same Redrob account as this engine.
 *
 * The daemon runs one of these beside its desk relay (service.ts). It only listens until the first
 * request: `desk.hello`, and with it the pairing notification in Chrome, goes out when a `browser`
 * tool call needs the browser. The device key and the browser it paired with are kept in the desk
 * secret scope (`browserKey`, `browserDesk`).
 */
import os from "node:os"
import type { RelayTicket } from "./auth"
import * as DeskCrypto from "./crypto"
import { decodeAction, decodeControl, encodeAction, encodeControl } from "./frames"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** After connecting, how long to wait for a browser to announce itself before saying there is none. */
export const ANNOUNCE_WAIT_MS = 4_000
/** How long a request waits for the person to press Allow in Chrome the first time. */
export const PAIR_WAIT_MS = 2 * 60_000
/** How long the extension keeps a pairing request (its `PENDING_MS`). */
export const PAIR_TTL_MS = 10 * 60_000
/** A later call while the same request still waits: long enough to show the code and catch an Allow. */
export const REPEAT_WAIT_MS = 20_000
const HANDSHAKE_WAIT_MS = 15_000
const REQUEST_TIMEOUT_MS = 30_000

export type BrowserState =
  /** No relay connection (signed out, desk off, or not connected yet). */
  | { readonly state: "off" }
  /** Connected; no browser with the Redrob extension is in the room. */
  | { readonly state: "none" }
  /** A browser is in the room; this engine has not asked it yet. */
  | { readonly state: "found"; readonly name: string }
  /** Asked; the person has to press Allow in that browser (the notification shows this code). */
  | { readonly state: "pairing"; readonly name: string; readonly code: string }
  | { readonly state: "ready"; readonly name: string }
  | { readonly state: "denied"; readonly name: string; readonly reason: string }

export type BrowserResponse = { readonly status: number; readonly body?: unknown }

/** No browser to talk to; `state` says why. The tool falls back to its own Chromium. */
export class BrowserUnavailable extends Error {
  constructor(readonly state: BrowserState) {
    super(describe(state))
  }
}

export function describe(state: BrowserState): string {
  switch (state.state) {
    case "off":
      return "not connected to the Redrob relay (sign in with `redrob desk login`, or open Redrob Desktop)"
    case "none":
      return "no Chrome with the Redrob extension is connected to this account (extension Settings → Redrob chat → Connect)"
    case "found":
      return `${state.name} is online`
    case "pairing":
      return `waiting for Allow in ${state.name} (code ${state.code})`
    case "ready":
      return `connected to ${state.name}`
    case "denied":
      return `${state.name} refused this engine (${state.reason}); allow it again from the extension's Settings`
  }
}

/** The relay socket as this module uses it; a test hands in a fake. */
export type Socket = {
  readonly readyState: number
  binaryType: string
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: any) => void): void
}

export type Secrets = {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
}

type Browser = {
  readonly id: string
  readonly pub: Uint8Array
  name: string
  peerId?: string
  ephemeral?: DeskCrypto.KeyPair
  channel?: DeskCrypto.Channel
  link: "idle" | "handshake" | "pending" | "ready" | "denied"
  code?: string
  reason?: string
  /** A request already waited out the Allow for the current pairing request. */
  waited?: boolean
  /** When the extension said the current pairing request is pending. */
  askedAt?: number
  /** The key this engine said hello with. */
  device?: DeskCrypto.KeyPair
  /** It left in the middle of a handshake: say hello again when it is back. */
  rehello?: boolean
  sending: Promise<void>
}

type Waiter = { resolve: (response: BrowserResponse) => void; reject: (error: Error) => void; browser: string }

const OPEN = 1

export class ExtensionLink {
  private socket?: Socket
  private ticket?: RelayTicket
  private stopped = true
  private delay = 1_000
  private reconnect?: ReturnType<typeof setTimeout>
  /** A ticket request is in flight. */
  private connecting = false
  private connectedAt = 0
  private readonly browsers = new Map<string, Browser>()
  private readonly peers = new Map<string, string>()
  private readonly waiting = new Map<number, Waiter>()
  private nextId = 1
  private inbound: Promise<void> = Promise.resolve()
  private changed: Array<() => void> = []
  private allowed?: Promise<DeskCrypto.KeyPair | undefined>
  /** The key of the pairing request going on, until it is allowed, denied or expires. */
  private candidate?: DeskCrypto.KeyPair
  private chosen?: string

  constructor(
    private readonly chat: { relayTicket(): Promise<RelayTicket> },
    private readonly secrets: Secrets,
    private readonly options: {
      /** How Chrome lists this engine in the extension's Settings. */
      readonly name?: string
      readonly socket?: (url: string) => Socket
      readonly announceWaitMs?: number
      readonly pairTtlMs?: number
      readonly repeatWaitMs?: number
      readonly log?: (message: string) => void
    } = {},
  ) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.secrets
      .get("browserDesk")
      .then((id) => (this.chosen ??= id))
      .catch(() => undefined)
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnect) clearTimeout(this.reconnect)
    const socket = this.socket
    this.socket = undefined
    socket?.close(1000, "stop")
    this.dropAll(new Error("the relay link stopped"))
  }

  /** A new token arrived (Redrob Desktop's `PUT /desk/token`): when not connected, try now instead of after the backoff. */
  kick(): void {
    if (this.stopped || this.socket) return
    this.delay = 1_000
    if (this.reconnect) clearTimeout(this.reconnect)
    this.reconnect = undefined
    void this.connect()
  }

  /** Where this engine stands with the person's browser, for `GET /desk/status`. */
  status(): BrowserState {
    if (!this.socket || this.socket.readyState !== OPEN) return { state: "off" }
    const browser = this.pick()
    if (!browser) return { state: "none" }
    switch (browser.link) {
      case "ready":
        return { state: "ready", name: browser.name }
      case "pending":
        return { state: "pairing", name: browser.name, code: browser.code ?? "" }
      case "denied":
        return { state: "denied", name: browser.name, reason: browser.reason ?? "denied" }
      default:
        return { state: "found", name: browser.name }
    }
  }

  /**
   * One request of the extension's route set. Says hello first when needed and waits (up to
   * `pairMs`) for the person to allow this engine. Throws `BrowserUnavailable` when there is no
   * browser to ask; the response's status is the extension's own (403 outside its allowlist).
   */
  async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options: { readonly pairMs?: number; readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<BrowserResponse> {
    const browser = await this.ready(options.pairMs ?? PAIR_WAIT_MS, options.signal)
    const id = this.nextId++
    return new Promise<BrowserResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`${browser.name} did not answer ${method} ${path}`))
      }, options.timeoutMs ?? REQUEST_TIMEOUT_MS)
      const done = () => clearTimeout(timer)
      this.waiting.set(id, {
        browser: browser.id,
        resolve: (response) => (done(), resolve(response)),
        reject: (error) => (done(), reject(error)),
      })
      this.seal(browser, { t: "req", id, method, path, ...(body === undefined ? {} : { body }) })
    })
  }

  // -- linking -----------------------------------------------------------------------------------

  private async ready(pairMs: number, signal?: AbortSignal): Promise<Browser> {
    if (this.stopped) throw new BrowserUnavailable({ state: "off" })
    // Connected, and either a browser announced itself or it had time to.
    await this.until(
      () => this.pick()?.peerId !== undefined || this.announceWaited(),
      HANDSHAKE_WAIT_MS + (this.options.announceWaitMs ?? ANNOUNCE_WAIT_MS),
      signal,
    )
    let browser = this.pick()
    if (!browser?.peerId) throw new BrowserUnavailable(this.status())
    if (browser.link === "denied") throw new BrowserUnavailable(this.status())
    // A request the extension has forgotten by now (its pairing requests last ten minutes), even
    // when its `desk.denied expired` never reached us: start a fresh one with a new key and code.
    const ttl = this.options.pairTtlMs ?? PAIR_TTL_MS
    if (browser.link === "pending" && browser.askedAt !== undefined && Date.now() - browser.askedAt >= ttl) {
      this.log(`the request to ${browser.name} (code ${browser.code}) expired; asking again`)
      if (browser.device === this.candidate) this.candidate = undefined
      browser.link = "idle"
      browser.waited = false
      browser.code = undefined
      browser.askedAt = undefined
    }
    // The person is asked to Allow once per request in Chrome: a call after one that already
    // waited the full time waits only briefly (the Allow still links this engine when it comes).
    const wait = browser.waited ? Math.min(pairMs, this.options.repeatWaitMs ?? REPEAT_WAIT_MS) : pairMs
    const deadline = Date.now() + wait
    if (browser.link === "idle") await this.hello(browser)
    await this.until(
      () => {
        browser = this.pick()
        if (!browser?.peerId) return true
        if (browser.link === "ready" || browser.link === "denied") return true
        // Still in the handshake: give it a moment. Pending: wait for the person up to the deadline.
        return browser.link === "pending" && Date.now() >= deadline
      },
      Math.max(wait, HANDSHAKE_WAIT_MS),
      signal,
    )
    browser = this.pick()
    if (browser?.link === "pending") browser.waited = true
    if (!browser?.peerId || browser.link !== "ready") throw new BrowserUnavailable(this.status())
    return browser
  }

  private announceWaited(): boolean {
    return this.connectedAt > 0 && Date.now() - this.connectedAt >= (this.options.announceWaitMs ?? ANNOUNCE_WAIT_MS)
  }

  /** Resolves when `check` is true, re-checked on every change and every 250 ms, or after `ms`. */
  private until(check: () => boolean, ms: number, signal?: AbortSignal): Promise<void> {
    if (check()) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const end = Date.now() + ms
      const finish = () => {
        clearInterval(tick)
        this.changed = this.changed.filter((listener) => listener !== test)
        signal?.removeEventListener("abort", aborted)
      }
      const test = () => {
        if (check() || Date.now() >= end) {
          finish()
          resolve()
        }
      }
      const aborted = () => {
        finish()
        reject(new Error("aborted"))
      }
      const tick = setInterval(test, 250)
      tick.unref?.()
      this.changed.push(test)
      if (signal?.aborted) return aborted()
      signal?.addEventListener("abort", aborted, { once: true })
    })
  }

  private notify(): void {
    for (const listener of [...this.changed]) listener()
  }

  /** The browser to talk to: the one paired before when it is online, else the first online one. */
  private pick(): Browser | undefined {
    const online = [...this.browsers.values()].filter((browser) => browser.peerId)
    return (
      online.find((browser) => browser.id === this.chosen) ??
      online.find((browser) => browser.link === "ready") ??
      online[0] ??
      (this.chosen ? this.browsers.get(this.chosen) : undefined)
    )
  }

  /**
   * The key the extension allowed before (`browserKey`, kept only once a `desk.accept` came), else
   * undefined. A key that was never allowed is not kept: each pairing request uses a fresh key,
   * so its six digits are new too, and an Allow left over from an earlier request cannot match.
   */
  private allowedKey(): Promise<DeskCrypto.KeyPair | undefined> {
    if (!this.allowed) {
      this.allowed = (async () => {
        const [stored, desk] = await Promise.all([this.secrets.get("browserKey"), this.secrets.get("browserDesk")])
        return stored && desk ? DeskCrypto.importPrivate(stored) : undefined
      })().catch(() => undefined)
    }
    return this.allowed
  }

  /** The name the extension shows in its Allow prompt and its list of allowed devices. */
  private get ownName(): string {
    return this.options.name ?? `Redrob Code on ${os.hostname()}`
  }

  private log(message: string): void {
    this.options.log?.(`${new Date().toISOString()} browser link: ${message}`)
  }

  private async hello(browser: Browser): Promise<void> {
    if (!browser.peerId) return
    const allowed = await this.allowedKey()
    // Not allowed yet: one key per pairing request, kept for as long as that request waits.
    const device = allowed ?? (this.candidate ??= await DeskCrypto.generate())
    const ephemeral = await DeskCrypto.generate()
    browser.device = device
    browser.ephemeral = ephemeral
    browser.channel = undefined
    browser.link = "handshake"
    browser.rehello = false
    // The extension shows the same six digits (ECDH both ways); known before it answers.
    browser.code = await DeskCrypto.devicePairingCode(device, browser.pub)
    this.log(
      allowed
        ? `hello to ${browser.name} (${browser.id}) as "${this.ownName}", allowed before`
        : `asking ${browser.name} (${browser.id}) to allow "${this.ownName}" (code ${browser.code})`,
    )
    this.notify()
    this.sendJson(
      "desk.hello",
      {
        v: 1,
        phone: DeskCrypto.b64url(device.pub),
        eph: DeskCrypto.b64url(ephemeral.pub),
        name: this.ownName,
        kind: "web",
      },
      browser.peerId,
    )
  }

  // -- socket ------------------------------------------------------------------------------------

  private schedule(): void {
    if (this.stopped) return
    const delay = this.delay
    this.delay = Math.min(this.delay * 2, 5 * 60_000)
    this.reconnect = setTimeout(() => void this.connect(), delay)
    this.reconnect.unref?.()
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.socket || this.connecting) return
    let ticket: RelayTicket
    this.connecting = true
    try {
      ticket = await this.chat.relayTicket()
    } catch (error) {
      this.log(`no relay ticket: ${error instanceof Error ? error.message : String(error)}`)
      return this.schedule()
    } finally {
      this.connecting = false
    }
    if (this.stopped || this.socket) return
    const url = new URL(ticket.url)
    url.searchParams.set("ticket", ticket.ticket)
    const socket = this.options.socket
      ? this.options.socket(url.toString())
      : (new WebSocket(url.toString()) as unknown as Socket)
    socket.binaryType = "arraybuffer"
    this.socket = socket
    this.ticket = ticket
    let openedAt = 0
    socket.addEventListener("open", () => {
      openedAt = Date.now()
      this.connectedAt = openedAt
      this.delay = 1_000
      // Every desk peer in the room answers `hello` with `desk.announce`.
      socket.send(encodeControl("hello", ticket.peerId))
      this.notify()
    })
    socket.addEventListener("message", (event: { data: string | ArrayBuffer }) => {
      const data = event.data
      this.inbound = this.inbound.then(() => this.onFrame(socket, data)).catch(() => undefined)
    })
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.connectedAt = 0
      this.dropAll(new Error("the relay connection closed"))
      if (this.stopped) return
      if (openedAt && Date.now() - openedAt > 60_000) this.delay = 1_000
      this.schedule()
    })
    socket.addEventListener("error", () => {
      // `close` follows and reconnects.
    })
  }

  private sendJson(namespace: string, value: unknown, targetId?: string): void {
    this.sendRaw(namespace, encoder.encode(JSON.stringify(value)), targetId)
  }

  private sendRaw(namespace: string, payload: Uint8Array, targetId?: string): void {
    const socket = this.socket
    const ticket = this.ticket
    if (!socket || !ticket || socket.readyState !== OPEN) return
    socket.send(encodeAction({ senderId: ticket.peerId, ...(targetId ? { targetId } : {}), namespace }, payload))
  }

  private seal(browser: Browser, message: Record<string, unknown>): void {
    const channel = browser.channel
    const target = browser.peerId
    if (!channel || !target) return
    const bytes = encoder.encode(JSON.stringify(message))
    browser.sending = browser.sending
      .then(async () => {
        if (browser.channel !== channel) return
        this.sendRaw("desk.msg", await channel.seal(bytes), target)
      })
      .catch(() => undefined)
  }

  // -- frames ------------------------------------------------------------------------------------

  private async onFrame(socket: Socket, data: string | ArrayBuffer): Promise<void> {
    if (socket !== this.socket) return
    const own = this.ticket?.peerId
    if (typeof data === "string") {
      const control = decodeControl(data)
      if (control?.type === "leave" && control.senderId !== own) this.leave(control.senderId)
      return
    }
    const frame = decodeAction(new Uint8Array(data))
    if (!frame || frame.senderId === own) return
    if (frame.targetId && frame.targetId !== own) return
    const text = () => {
      try {
        return JSON.parse(decoder.decode(frame.payload)) as Record<string, unknown>
      } catch {
        return undefined
      }
    }
    switch (frame.namespace) {
      case "desk.announce":
        return this.onAnnounce(frame.senderId, text())
      case "desk.pending":
        return this.onPending(frame.senderId)
      case "desk.accept":
        return this.onAccept(frame.senderId, text())
      case "desk.denied":
        return this.onDenied(frame.senderId, text())
      case "desk.msg":
        return this.onMessage(frame.senderId, frame.payload)
    }
  }

  private browserOf(peerId: string): Browser | undefined {
    const id = this.peers.get(peerId)
    return id ? this.browsers.get(id) : undefined
  }

  private async onAnnounce(peerId: string, announce: Record<string, unknown> | undefined): Promise<void> {
    // Only the extension: a PC running Redrob Code announces without `kind`.
    if (!announce || announce.v !== 1 || announce.kind !== "browser") return
    if (typeof announce.desk !== "string" || typeof announce.deskId !== "string") return
    const pub = DeskCrypto.fromB64url(announce.desk)
    if (pub.byteLength !== 65 || (await DeskCrypto.keyId(pub)) !== announce.deskId) return
    const name = typeof announce.name === "string" && announce.name.trim() ? announce.name.slice(0, 100) : "Chrome"
    let browser = this.browsers.get(announce.deskId)
    if (browser && DeskCrypto.b64url(browser.pub) !== announce.desk) return
    if (!browser) {
      browser = { id: announce.deskId, pub, name, link: "idle", sending: Promise.resolve() }
      this.browsers.set(browser.id, browser)
    }
    browser.name = name
    const samePeer = browser.peerId === peerId
    if (!samePeer) this.log(`${name} (${browser.id}) is online`)
    if (browser.peerId && !samePeer) this.peers.delete(browser.peerId)
    browser.peerId = peerId
    this.peers.set(peerId, browser.id)
    // A new connection of that browser (its worker restarted, or it left in the middle of the
    // handshake): its old session and its pairing request are gone. Say hello again when this
    // engine had been talking to it, with the same key, so the code on screen stays the same.
    if (!samePeer && (browser.rehello || (browser.link !== "idle" && browser.link !== "denied"))) {
      this.fail(browser.id, new Error(`${browser.name} reconnected`))
      browser.channel = undefined
      browser.link = "idle"
      await this.hello(browser)
    }
    this.notify()
  }

  private async onPending(peerId: string): Promise<void> {
    const browser = this.browserOf(peerId)
    if (!browser || browser.link !== "handshake") return
    if (browser.device && browser.device === (await this.allowedKey())) {
      // The extension forgot this engine (removed in its Settings, or reinstalled): start a new
      // pairing request with a fresh key instead of re-showing the old one's code.
      this.log(`${browser.name} no longer knows this engine; asking again`)
      await this.forgetAllowed()
      return this.hello(browser)
    }
    browser.link = "pending"
    // A hello again with the same key keeps the extension's first deadline, so keep ours too.
    browser.askedAt ??= Date.now()
    this.log(`waiting for Allow in ${browser.name}: "${this.ownName}" asks, code ${browser.code}`)
    this.notify()
  }

  private async forgetAllowed(): Promise<void> {
    this.allowed = Promise.resolve(undefined)
    this.candidate = undefined
    await this.secrets.set("browserDesk", "").catch(() => undefined)
  }

  private async onAccept(peerId: string, accept: Record<string, unknown> | undefined): Promise<void> {
    const browser = this.browserOf(peerId)
    const ephemeral = browser?.ephemeral
    const device = browser?.device
    if (!browser || !ephemeral || !device || !this.ticket || typeof accept?.eph !== "string") return
    const deskEph = DeskCrypto.fromB64url(accept.eph)
    try {
      browser.channel = await DeskCrypto.Channel.device({
        device,
        ephemeral,
        deskPub: browser.pub,
        deskEph,
        ownPeerId: this.ticket.peerId,
        deskPeerId: peerId,
      })
    } catch {
      return
    }
    browser.link = "ready"
    browser.code = undefined
    browser.waited = false
    browser.askedAt = undefined
    this.log(`${browser.name} allowed "${this.ownName}"; linked`)
    // Keep the key only now that the extension knows it: the next start says hello without a code.
    if (this.candidate === device) {
      this.candidate = undefined
      this.allowed = Promise.resolve(device)
      await this.secrets.set("browserKey", await DeskCrypto.exportPrivate(device)).catch(() => undefined)
      await this.secrets.set("browserDesk", browser.id).catch(() => undefined)
    }
    if (this.chosen !== browser.id) {
      this.chosen = browser.id
      await this.secrets.set("browserDesk", browser.id).catch(() => undefined)
    }
    this.notify()
  }

  private onDenied(peerId: string, denied: Record<string, unknown> | undefined): void {
    const browser = this.browserOf(peerId)
    if (!browser) return
    browser.channel = undefined
    const reason = typeof denied?.reason === "string" ? denied.reason : "denied"
    // An Allow nobody pressed in time: the next request asks again. A Deny or a removal sticks
    // until this link restarts, so Chrome is not asked over and over.
    browser.link = reason === "expired" ? "idle" : "denied"
    browser.reason = reason
    browser.waited = false
    browser.askedAt = undefined
    browser.code = undefined
    this.log(`${browser.name} answered ${reason}`)
    // That pairing request is over: the next one gets a fresh key and code.
    if (browser.device === this.candidate) this.candidate = undefined
    else if (reason === "revoked") void this.forgetAllowed()
    this.fail(browser.id, new BrowserUnavailable(this.status()))
    this.notify()
  }

  private async onMessage(peerId: string, payload: Uint8Array): Promise<void> {
    const browser = this.browserOf(peerId)
    const channel = browser?.channel
    if (!browser || !channel) return
    let plain: Uint8Array | undefined
    try {
      plain = await channel.open(payload)
    } catch {
      // A bad tag ends the session: start a fresh handshake.
      this.fail(browser.id, new Error(`the session with ${browser.name} broke`))
      await this.hello(browser)
      return
    }
    if (!plain) return
    let message: { t?: unknown; id?: unknown; status?: unknown; body?: unknown }
    try {
      message = JSON.parse(decoder.decode(plain))
    } catch {
      return
    }
    if (message.t !== "res" || typeof message.id !== "number" || typeof message.status !== "number") return
    const waiter = this.waiting.get(message.id)
    if (!waiter || waiter.browser !== browser.id) return
    this.waiting.delete(message.id)
    waiter.resolve({ status: message.status, ...(message.body === undefined ? {} : { body: message.body }) })
  }

  private leave(peerId: string): void {
    const browser = this.browserOf(peerId)
    this.peers.delete(peerId)
    if (!browser) return
    browser.peerId = undefined
    browser.channel = undefined
    if (browser.link === "handshake" || browser.link === "pending" || browser.link === "ready") browser.rehello = true
    if (browser.link !== "denied") browser.link = "idle"
    this.log(`${browser.name} (${browser.id}) went offline`)
    this.fail(browser.id, new Error(`${browser.name} went offline`))
    this.notify()
  }

  private fail(browserId: string, error: Error): void {
    for (const [id, waiter] of this.waiting) {
      if (waiter.browser !== browserId) continue
      this.waiting.delete(id)
      waiter.reject(error)
    }
  }

  private dropAll(error: Error): void {
    for (const browser of this.browsers.values()) {
      browser.peerId = undefined
      browser.channel = undefined
      if (browser.link !== "denied") browser.link = "idle"
    }
    this.peers.clear()
    for (const waiter of this.waiting.values()) waiter.reject(error)
    this.waiting.clear()
    this.notify()
  }
}
