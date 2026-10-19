/**
 * @redrob-code/channels-whatsapp: the WhatsApp transport, over Baileys.
 *
 * Baileys speaks the WhatsApp Web protocol directly, so there is no bot token: the daemon is paired
 * as a *linked device* of a WhatsApp account by scanning a QR code once. The session that pairing
 * produces lives in `~/.redrob/channels/whatsapp/` (mode 0700, written by Baileys'
 * `useMultiFileAuthState`) and is reused on every start until the phone unlinks it.
 *
 * Pairing is exposed rather than printed: `start()` resolves as soon as the socket has either
 * connected or produced a QR code, `qr()` returns the latest raw QR string, `qrDataUrl()` the same
 * as a PNG data URL, and the PNG is also written to `~/.redrob/channels/whatsapp/qr.png` so a
 * launcher can show it. `paired()` says whether the account is linked right now. The file is
 * removed once the connection opens.
 *
 * Message mapping: `conversationId` is the chat's `remoteJid` (a user or a group), `senderId` is the
 * phone number of the sender (the `participant` in a group, the chat itself in a direct chat), so
 * the allowlist takes plain numbers like `821012345678`. The transport's own messages (`fromMe`)
 * and status broadcasts are dropped before they reach the core.
 */
import fs from "node:fs/promises"
import path from "node:path"
import { Paths, type Inbound, type Logger, type Transport, type TransportContext, type TransportFactory } from "@redrob-code/channels-core"
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidStatusBroadcast,
  jidDecode,
  useMultiFileAuthState,
  type UserFacingSocketConfig,
  type WAMessage,
  type WASocket,
  type proto,
} from "@whiskeysockets/baileys"
import QRCode from "qrcode"

/** Baileys' pino-shaped logger interface, which the package does not re-export. */
type BaileysLogger = NonNullable<UserFacingSocketConfig["logger"]>

/** WhatsApp accepts 65536 characters in a text message; 4000 keeps replies readable on a phone. */
export const WHATSAPP_MAX_CHUNK = 4000

/** Non-secret settings read from `channels.json` -> `channels.whatsapp.options`. */
export type WhatsAppOptions = {
  /**
   * Show the linked device as online while the daemon runs. Off by default: an online linked device
   * stops WhatsApp from pushing notifications to the phone.
   */
  readonly markOnlineOnConnect?: boolean
  /** Longest reconnect wait in milliseconds. Default 30000. */
  readonly maxReconnectMs?: number
}

export type PairingState = "paired" | "pairing" | "disconnected"

/** Where the pairing session and the QR image live: `<channels dir>/whatsapp`. */
export function authDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(Paths.directory(env), "whatsapp")
}

export function qrFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(authDirectory(env), "qr.png")
}

function options(ctx: TransportContext): WhatsAppOptions {
  const raw = ctx.config.options ?? {}
  return {
    markOnlineOnConnect: raw.markOnlineOnConnect === true,
    maxReconnectMs: typeof raw.maxReconnectMs === "number" && raw.maxReconnectMs > 0 ? raw.maxReconnectMs : 30_000,
  }
}

/** The phone-number part of a JID: `821012345678:3@s.whatsapp.net` -> `821012345678`. */
export function phoneOf(jid: string | undefined | null): string | undefined {
  if (!jid) return undefined
  const decoded = jidDecode(jid)
  return decoded?.user || undefined
}

/** The text a human typed, unwrapping ephemeral / view-once / edited envelopes; undefined for media without caption. */
export function textOf(message: proto.IMessage | null | undefined): string | undefined {
  let m = message ?? undefined
  for (let i = 0; m && i < 4; i++) {
    const inner =
      m.ephemeralMessage?.message ??
      m.viewOnceMessage?.message ??
      m.viewOnceMessageV2?.message ??
      m.documentWithCaptionMessage?.message ??
      m.editedMessage?.message?.protocolMessage?.editedMessage
    if (!inner) break
    m = inner
  }
  if (!m) return undefined
  const text =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption
  return typeof text === "string" && text.trim() !== "" ? text : undefined
}

/** Baileys wants a pino-shaped logger; route warnings and errors to the channel log and drop the rest. */
function baileysLogger(log: Logger): BaileysLogger {
  const describe = (obj: unknown, msg?: string): string => {
    if (msg) return msg
    if (obj instanceof Error) return obj.message
    if (typeof obj === "string") return obj
    try {
      return JSON.stringify(obj)
    } catch {
      return String(obj)
    }
  }
  const logger: BaileysLogger = {
    level: "warn",
    child: () => logger,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: (obj: unknown, msg?: string) => log.warn(`baileys: ${describe(obj, msg)}`),
    error: (obj: unknown, msg?: string) => log.error(`baileys: ${describe(obj, msg)}`),
  }
  return logger
}

function statusCode(error: unknown): number | undefined {
  const output = (error as { output?: { statusCode?: unknown } } | undefined)?.output
  return typeof output?.statusCode === "number" ? output.statusCode : undefined
}

export class WhatsAppTransport implements Transport {
  readonly name = "whatsapp"
  readonly maxChunk = WHATSAPP_MAX_CHUNK

  private readonly env: NodeJS.ProcessEnv
  private ctx?: TransportContext
  private sock?: WASocket
  private saveCreds?: () => Promise<void>
  private stopping = false
  private open = false
  private latestQr?: string
  private latestQrDataUrl?: string
  private reconnectAttempt = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env
  }

  /** The latest QR code as the raw string WhatsApp expects, while pairing; undefined once paired. */
  qr(): string | undefined {
    return this.latestQr
  }

  /** The latest QR code as a `data:image/png;base64,...` URL, while pairing. */
  qrDataUrl(): string | undefined {
    return this.latestQrDataUrl
  }

  /** Whether the account is linked and the socket is open. */
  paired(): boolean {
    return this.open
  }

  pairing(): PairingState {
    if (this.open) return "paired"
    if (this.latestQr) return "pairing"
    return "disconnected"
  }

  /**
   * Resolves once the socket is open *or* a QR code is waiting to be scanned, so an unpaired channel
   * still starts and the launcher can pick the QR up. Rejects when the connection closes for good
   * before either happens.
   */
  async start(ctx: TransportContext): Promise<void> {
    this.ctx = ctx
    this.stopping = false
    const dir = authDirectory(this.env)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.chmod(dir, 0o700).catch(() => undefined)
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const done = (error?: Error) => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else resolve()
      }
      void this.connect(done).catch((error: unknown) => done(error instanceof Error ? error : new Error(String(error))))
    })
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const sock = this.sock
    this.sock = undefined
    this.open = false
    this.clearQr()
    await this.removeQrFile()
    if (sock) {
      try {
        sock.ev.removeAllListeners("connection.update")
        sock.ev.removeAllListeners("messages.upsert")
        sock.ev.removeAllListeners("creds.update")
        sock.end(undefined)
      } catch {
        // already closed
      }
    }
  }

  async send(conversationId: string, chunks: readonly string[]): Promise<void> {
    const sock = this.socket()
    for (const chunk of chunks) {
      await sock.sendMessage(conversationId, { text: chunk })
    }
    await sock.sendPresenceUpdate("paused", conversationId).catch(() => undefined)
  }

  async typing(conversationId: string): Promise<void> {
    await this.socket().sendPresenceUpdate("composing", conversationId)
  }

  private socket(): WASocket {
    if (!this.sock || !this.open) throw new Error("WhatsApp is not connected (not paired yet, or reconnecting)")
    return this.sock
  }

  private log(): Logger {
    return this.ctx!.log
  }

  /** Build a socket and wire events. `settle` is the pending start(), if any. */
  private async connect(settle?: (error?: Error) => void): Promise<void> {
    const ctx = this.ctx!
    const opts = options(ctx)
    const dir = authDirectory(this.env)
    const { state, saveCreds } = await useMultiFileAuthState(dir)
    this.saveCreds = saveCreds
    // Baileys' auth files are written 0644 inside our 0700 folder; the folder is the guard.
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }))
    const sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      logger: baileysLogger(ctx.log),
      browser: Browsers.ubuntu("Redrob Code"),
      markOnlineOnConnect: opts.markOnlineOnConnect === true,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      // Ignore status updates and broadcast lists at the socket; groups and chats still arrive.
      shouldIgnoreJid: (jid) => isJidStatusBroadcast(jid) || jid.endsWith("@broadcast"),
    })
    this.sock = sock

    sock.ev.on("creds.update", () => {
      void this.saveCreds?.().catch((error: unknown) =>
        ctx.log.warn(`could not save credentials: ${error instanceof Error ? error.message : String(error)}`),
      )
    })

    sock.ev.on("connection.update", (update) => {
      if (this.sock !== sock) return
      if (update.qr) {
        this.reconnectAttempt = 0
        void this.publishQr(update.qr).then(() => settle?.())
      }
      if (update.connection === "open") {
        this.open = true
        this.reconnectAttempt = 0
        this.clearQr()
        void this.removeQrFile()
        const me = phoneOf(sock.user?.id)
        ctx.log.info(`connected${me ? ` as +${me}` : ""}`)
        settle?.()
      }
      if (update.connection === "close") {
        this.open = false
        const code = statusCode(update.lastDisconnect?.error)
        const reason = update.lastDisconnect?.error?.message ?? "connection closed"
        if (this.stopping) return
        if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
          // The phone unlinked this device (or WhatsApp refused it). The stored session is dead;
          // drop it and come back with a fresh QR so the account can be re-paired.
          ctx.log.warn(`logged out by WhatsApp (${code}); clearing the pairing session, a new QR code will follow`)
          void this.resetSession().then(() => this.scheduleReconnect(settle, 1_000))
          return
        }
        if (code === DisconnectReason.connectionReplaced) {
          const error = new Error("another WhatsApp Web session replaced this one; stop the other client and restart the channel")
          ctx.log.error(error.message)
          settle?.(error)
          return
        }
        const wait = code === DisconnectReason.restartRequired ? 500 : this.backoff(opts.maxReconnectMs ?? 30_000)
        ctx.log.warn(`disconnected (${code ?? "?"}: ${reason}); reconnecting in ${wait}ms`)
        this.scheduleReconnect(settle, wait)
      }
    })

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (this.sock !== sock) return
      // "append" is history sync and offline backfill; only live notifications are prompts.
      if (type !== "notify") return
      for (const message of messages) this.inbound(message)
    })
  }

  private inbound(message: WAMessage): void {
    const ctx = this.ctx
    if (!ctx) return
    const key = message.key
    const remoteJid = key.remoteJid ?? undefined
    if (!remoteJid || key.fromMe || isJidStatusBroadcast(remoteJid) || remoteJid.endsWith("@broadcast")) return
    const text = textOf(message.message)
    if (text === undefined) return
    // In a group the sender is the participant; in a direct chat it is the chat itself. Prefer the
    // phone-number form when WhatsApp handed us a LID (`@lid`) with its number alongside.
    const senderJid = key.participant ? (key.participantPn ?? key.participant) : (key.senderPn ?? remoteJid)
    const senderId = phoneOf(senderJid)
    if (!senderId) return
    const inbound: Inbound = {
      channel: this.name,
      conversationId: remoteJid,
      senderId,
      ...(message.pushName ? { senderName: message.pushName } : {}),
      text,
      ...(key.id ? { replyTo: key.id } : {}),
    }
    ctx.onMessage(inbound)
  }

  private async publishQr(qr: string): Promise<void> {
    this.latestQr = qr
    try {
      this.latestQrDataUrl = await QRCode.toDataURL(qr, { errorCorrectionLevel: "M", margin: 2, scale: 6 })
      const file = qrFile(this.env)
      const temp = `${file}.${process.pid}.tmp`
      await QRCode.toFile(temp, qr, { type: "png", errorCorrectionLevel: "M", margin: 2, scale: 6 })
      await fs.chmod(temp, 0o600).catch(() => undefined)
      await fs.rename(temp, file)
      this.log().info(`not paired: scan the QR code at ${path.basename(file)} in WhatsApp > Linked devices`)
    } catch (error) {
      this.log().warn(`could not render the QR code: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private clearQr(): void {
    this.latestQr = undefined
    this.latestQrDataUrl = undefined
  }

  private async removeQrFile(): Promise<void> {
    await fs.rm(qrFile(this.env), { force: true }).catch(() => undefined)
  }

  /** Delete Baileys' credential and key files so the next connect starts a fresh pairing. */
  private async resetSession(): Promise<void> {
    const dir = authDirectory(this.env)
    const entries = await fs.readdir(dir).catch(() => [] as string[])
    await Promise.all(
      entries.filter((name) => name.endsWith(".json")).map((name) => fs.rm(path.join(dir, name), { force: true }).catch(() => undefined)),
    )
  }

  private backoff(max: number): number {
    const wait = Math.min(max, 1_000 * 2 ** Math.min(this.reconnectAttempt, 10))
    this.reconnectAttempt++
    return wait
  }

  private scheduleReconnect(settle: ((error?: Error) => void) | undefined, wait: number): void {
    if (this.stopping) return
    const previous = this.sock
    this.sock = undefined
    try {
      previous?.ev.removeAllListeners("connection.update")
      previous?.ev.removeAllListeners("messages.upsert")
      previous?.ev.removeAllListeners("creds.update")
    } catch {
      // nothing to detach
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.stopping) return
      void this.connect(settle).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.log().error(`reconnect failed: ${message}`)
        if (settle) settle(error instanceof Error ? error : new Error(message))
        else this.scheduleReconnect(undefined, this.backoff(options(this.ctx!).maxReconnectMs ?? 30_000))
      })
    }, wait)
  }
}

export const whatsappTransport: TransportFactory = () => new WhatsAppTransport()
