/**
 * The desk relay connection (redrob-mobile `docs/desk-relay.md`, sections 1 and 3).
 *
 * The daemon gets a ticket from `POST <chat>/mobile/relay-ticket {as:"desk"}`, joins the room
 * `desk:<user id>` on the Design relay, says `hello`, and broadcasts `desk.announce` after
 * connecting and after every `hello` it sees. A device is the phone app or a web browser profile
 * (`desk.hello` `kind`, missing means "phone"). A known device's `desk.hello` is answered with
 * `desk.accept` and becomes an encrypted session handed to the forwarder; an unknown device's gets
 * `desk.pending` and waits for the launcher's "allow once" (or `redrob desk approve <code>`). The relay closes every
 * connection after 30 minutes; the daemon gets a fresh ticket and reconnects, with backoff after
 * failures.
 */
import type { DaemonConnection } from "@redrob-code/channels-core"
import { InstallationVersion } from "@redrob-code/core/installation/version"
import { AccessTokens, ChatApi, endpoints, type RelayTicket } from "./auth"
import * as DeskCrypto from "./crypto"
import { DaemonApi } from "./daemon"
import { Forwarder, type Link } from "./forward"
import {
  MACHINE_NAMESPACE,
  decodeAction,
  decodeControl,
  encodeAction,
  encodeControl,
  encodeMachine,
  type MachineFrame,
} from "./frames"
import { Pairing, deviceKind, type Device, type DeviceKind, type PendingRequest } from "./pairing"
import { machine } from "./settings"
import { ToolCatalog } from "./tools"

/** State changes closer together than this go out as one `desk.machine`. */
const MACHINE_DEBOUNCE_MS = 1_000

const encoder = new TextEncoder()
const decoder = new TextDecoder()

type Peer = {
  readonly peerId: string
  deviceId?: string
  devicePub?: Uint8Array
  deviceEph?: Uint8Array
  name?: string
  kind?: DeviceKind
  channel?: DeskCrypto.Channel
  link?: Link
  /** Sealed frames go out in counter order. */
  sending: Promise<void>
}

export type Logger = { info(message: string): void; warn(message: string): void }

export const consoleLogger: Logger = {
  info: (m) => console.log(`[desk] ${m}`),
  warn: (m) => console.warn(`[desk] ${m}`),
}

/** Relay-side state for `GET /desk/status`. */
export type RelayStatus = {
  readonly connected: boolean
  /** Ids of approved devices with an open encrypted session right now. */
  readonly online: ReadonlySet<string>
}

export class DeskRelay {
  private readonly api: DaemonApi
  private readonly chat: ChatApi
  private readonly forwarder: Forwarder
  private readonly tools: ToolCatalog
  private readonly peers = new Map<string, Peer>()
  private socket?: WebSocket
  private ticket?: RelayTicket
  private stopped = true
  private delay = 1_000
  private reconnect?: ReturnType<typeof setTimeout>
  private timers: ReturnType<typeof setInterval>[] = []
  /** Inbound frames are handled one at a time, so receive counters see them in order. */
  private inbound: Promise<void> = Promise.resolve()
  /** The last `desk.machine` sent on the current connection. */
  private machineSent?: MachineFrame
  private machineTimer?: ReturnType<typeof setTimeout>

  constructor(
    daemon: DaemonConnection,
    private readonly pairing: Pairing = new Pairing(),
    private readonly log: Logger = consoleLogger,
    /** Overrides the machine name from the desk settings (hostname by default). */
    private readonly name?: string,
  ) {
    const { issuer, chatApi } = endpoints()
    this.api = new DaemonApi(daemon)
    this.chat = new ChatApi(chatApi, new AccessTokens(issuer, pairing.tokens()))
    this.forwarder = new Forwarder(
      this.api,
      (kind, sessionId) => this.notify(kind, sessionId),
      (m) => this.log.warn(m),
      () => this.machineChanged(),
    )
    this.tools = new ToolCatalog(this.api, InstallationVersion)
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.forwarder.start()
    const refreshTools = () => void this.tools.refresh().catch(() => undefined)
    refreshTools()
    this.timers.push(
      setInterval(refreshTools, 60_000),
      setInterval(() => this.expire(), 30_000),
      // Turns that start and end without a bus event the forwarder sees are caught here.
      setInterval(() => this.machineChanged(), 60_000),
    )
    for (const timer of this.timers) timer.unref?.()
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnect) clearTimeout(this.reconnect)
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    if (this.machineTimer) clearTimeout(this.machineTimer)
    this.machineTimer = undefined
    // Tell the room this machine is going off, while the socket is still open.
    if (this.machineSent) this.sendRaw(MACHINE_NAMESPACE, encodeMachine({ ...this.machineSent, online: false }))
    this.machineSent = undefined
    this.forwarder.stop()
    this.dropAll()
    this.socket?.close(1000, "stop")
    this.socket = undefined
  }

  // -- connection ------------------------------------------------------------------------------

  private schedule(): void {
    if (this.stopped) return
    const delay = this.delay
    this.delay = Math.min(this.delay * 2, 5 * 60_000)
    this.reconnect = setTimeout(() => void this.connect(), delay)
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    let ticket: RelayTicket
    try {
      ticket = await this.chat.relayTicket()
    } catch (error) {
      this.log.warn(`no relay ticket: ${error instanceof Error ? error.message : String(error)}`)
      return this.schedule()
    }
    if (this.stopped) return
    const url = new URL(ticket.url)
    url.searchParams.set("ticket", ticket.ticket)
    const socket = new WebSocket(url.toString())
    socket.binaryType = "arraybuffer"
    this.socket = socket
    this.ticket = ticket
    let openedAt = 0
    socket.addEventListener("open", () => {
      openedAt = Date.now()
      this.delay = 1_000
      socket.send(encodeControl("hello", ticket.peerId))
      void this.announce()
      this.log.info("relay connected")
    })
    socket.addEventListener("message", (event) => {
      const data = event.data as string | ArrayBuffer
      this.inbound = this.inbound.then(() => this.onFrame(socket, data)).catch(() => undefined)
    })
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.machineSent = undefined
      this.dropAll()
      if (this.stopped) return
      // A connection that lived (the relay's 30-minute close, a server restart) comes straight
      // back with a fresh ticket; one that failed at once backs off.
      if (openedAt && Date.now() - openedAt > 60_000) this.delay = 1_000
      this.log.info(`relay closed (${event.code}); reconnecting`)
      this.schedule()
    })
    socket.addEventListener("error", () => {
      // `close` follows and reconnects.
    })
  }

  private send(socket: WebSocket, namespace: string, payload: Uint8Array, targetId?: string): void {
    const ticket = this.ticket
    if (!ticket || socket.readyState !== WebSocket.OPEN) return
    socket.send(encodeAction({ senderId: ticket.peerId, ...(targetId ? { targetId } : {}), namespace }, payload))
  }

  private sendJson(namespace: string, value: unknown, targetId?: string): void {
    this.sendRaw(namespace, encoder.encode(JSON.stringify(value)), targetId)
  }

  private sendRaw(namespace: string, payload: Uint8Array, targetId?: string): void {
    if (this.socket) this.send(this.socket, namespace, payload, targetId)
  }

  private async announce(): Promise<void> {
    const [desk, self] = await Promise.all([this.pairing.key(), machine()])
    this.sendJson("desk.announce", {
      v: 1,
      desk: DeskCrypto.b64url(desk.pub),
      deskId: await DeskCrypto.keyId(desk.pub),
      name: this.name ?? self.name,
      machineId: self.id,
    })
    await this.sendMachine(true)
  }

  // -- machine registration (desk.machine) -----------------------------------------------------

  /** Something that may change the machine's state happened; send it soon. */
  machineChanged(): void {
    if (this.stopped || this.machineTimer) return
    this.machineTimer = setTimeout(() => {
      this.machineTimer = undefined
      void this.sendMachine(false).catch(() => undefined)
    }, MACHINE_DEBOUNCE_MS)
    this.machineTimer.unref?.()
  }

  private async machineFrame(): Promise<MachineFrame> {
    const [self, active] = await Promise.all([
      machine(),
      this.api.raw("GET", "/api/session/active").catch(() => undefined),
    ])
    const data = (active?.body as { data?: unknown } | undefined)?.data
    const sessions = typeof data === "object" && data !== null ? Object.keys(data).length : 0
    return {
      v: 1,
      machineId: self.id,
      name: this.name ?? self.name,
      kind: self.kind,
      os: self.os,
      online: true,
      sessions,
      approvals: this.forwarder.approvals(),
    }
  }

  /** Send `desk.machine` when it differs from the last one sent (always when `force`). */
  private async sendMachine(force: boolean): Promise<void> {
    if (!this.connected) return
    const frame = await this.machineFrame()
    if (!force && this.machineSent && JSON.stringify(this.machineSent) === JSON.stringify(frame)) return
    if (!this.connected) return
    this.sendRaw(MACHINE_NAMESPACE, encodeMachine(frame))
    this.machineSent = frame
  }

  // -- frames ----------------------------------------------------------------------------------

  private async onFrame(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (socket !== this.socket) return
    if (typeof data === "string") {
      const control = decodeControl(data)
      if (!control || control.senderId === this.ticket?.peerId) return
      if (control.type === "hello") {
        socket.send(encodeControl("welcome", this.ticket!.peerId, control.senderId))
        await this.announce()
      } else if (control.type === "leave") {
        this.drop(control.senderId)
      }
      return
    }
    const frame = decodeAction(new Uint8Array(data))
    if (!frame || frame.senderId === this.ticket?.peerId) return
    if (frame.targetId && frame.targetId !== this.ticket?.peerId) return
    if (frame.namespace === "desk.hello") return this.onHello(frame.senderId, frame.payload)
    if (frame.namespace === "desk.msg") return this.onMessage(frame.senderId, frame.payload)
  }

  private async onHello(peerId: string, payload: Uint8Array): Promise<void> {
    let hello: { v?: unknown; phone?: unknown; eph?: unknown; name?: unknown; kind?: unknown }
    try {
      hello = JSON.parse(decoder.decode(payload))
    } catch {
      return
    }
    if (hello.v !== 1 || typeof hello.phone !== "string" || typeof hello.eph !== "string") return
    const devicePub = DeskCrypto.fromB64url(hello.phone)
    const deviceEph = DeskCrypto.fromB64url(hello.eph)
    try {
      await DeskCrypto.importPublic(devicePub)
      await DeskCrypto.importPublic(deviceEph)
    } catch {
      return
    }
    this.drop(peerId)
    const deviceId = await DeskCrypto.keyId(devicePub)
    const kind = deviceKind(hello.kind)
    const name = typeof hello.name === "string" && hello.name.trim() ? hello.name.slice(0, 100) : kind
    const peer: Peer = { peerId, deviceId, devicePub, deviceEph, name, kind, sending: Promise.resolve() }
    this.peers.set(peerId, peer)
    const known = await this.pairing.device(deviceId)
    if (known && known.pub === hello.phone) return this.accept(peer)
    const request = await this.pairing.request({ devicePub, name, kind, peerId })
    this.log.info(`pairing request from "${request.name}" (${request.kind}); run: redrob desk approve ${request.code}`)
    this.sendJson("desk.pending", { v: 1 }, peerId)
  }

  private async accept(peer: Peer): Promise<void> {
    if (!peer.devicePub || !peer.deviceEph || !this.ticket) return
    const ephemeral = await DeskCrypto.generate()
    const channel = await DeskCrypto.Channel.create({
      desk: await this.pairing.key(),
      ephemeral,
      phonePub: peer.devicePub,
      phoneEph: peer.deviceEph,
      ownPeerId: this.ticket.peerId,
      phonePeerId: peer.peerId,
    })
    peer.channel = channel
    peer.link = this.forwarder.link((message) => this.seal(peer, message), peer.name ?? peer.deviceId)
    this.sendJson("desk.accept", { v: 1, eph: DeskCrypto.b64url(ephemeral.pub) }, peer.peerId)
  }

  private seal(peer: Peer, message: Record<string, unknown>): Promise<void> {
    const socket = this.socket
    const channel = peer.channel
    if (!socket || !channel) return Promise.resolve()
    const bytes = encoder.encode(JSON.stringify(message))
    peer.sending = peer.sending
      .then(async () => {
        if (peer.channel !== channel) return
        this.send(socket, "desk.msg", await channel.seal(bytes), peer.peerId)
      })
      .catch(() => undefined)
    return peer.sending
  }

  private async onMessage(peerId: string, payload: Uint8Array): Promise<void> {
    const peer = this.peers.get(peerId)
    if (!peer?.channel || !peer.link) return
    let plain: Uint8Array | undefined
    try {
      plain = await peer.channel.open(payload)
    } catch {
      // A bad tag ends the session; the device says hello again.
      this.drop(peerId)
      return
    }
    if (!plain) return
    let message: unknown
    try {
      message = JSON.parse(decoder.decode(plain))
    } catch {
      return
    }
    const link = peer.link
    void this.forwarder.handle(link, message).catch((error: unknown) => {
      this.log.warn(`request failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private drop(peerId: string): void {
    const peer = this.peers.get(peerId)
    if (!peer) return
    if (peer.link) this.forwarder.unlink(peer.link)
    this.peers.delete(peerId)
  }

  private dropAll(): void {
    for (const peerId of [...this.peers.keys()]) this.drop(peerId)
  }

  // -- push ------------------------------------------------------------------------------------

  private async notify(kind: "done" | "approval", sessionId: string): Promise<void> {
    const title = await this.api.sessionTitle(sessionId).catch(() => undefined)
    await this.chat.notify(kind, sessionId, title).catch((error: unknown) => {
      this.log.warn(`push failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // -- pairing (the CLI surface) ---------------------------------------------------------------

  private expire(): void {
    for (const request of this.pairing.sweep()) this.refuse(request.peerId, request.deviceId, "expired")
  }

  private refuse(peerId: string, deviceId: string, reason: "denied" | "revoked" | "expired"): void {
    const peer = this.peers.get(peerId)
    if (!peer || peer.deviceId !== deviceId) return
    this.sendJson("desk.denied", { v: 1, reason }, peerId)
    this.drop(peerId)
  }

  status(): RelayStatus {
    const online = new Set<string>()
    for (const peer of this.peers.values()) if (peer.channel && peer.deviceId) online.add(peer.deviceId)
    return { connected: this.connected, online }
  }

  async approve(code: string): Promise<Device> {
    const { request, device } = await this.pairing.approve(code)
    const peer = this.peers.get(request.peerId)
    if (peer && peer.deviceId === request.deviceId && !peer.channel) await this.accept(peer)
    return device
  }

  deny(code: string): PendingRequest {
    const request = this.pairing.deny(code)
    this.refuse(request.peerId, request.deviceId, "denied")
    return request
  }

  async revoke(id: string): Promise<Device> {
    const device = await this.pairing.revoke(id)
    for (const peer of [...this.peers.values()]) if (peer.deviceId === id) this.refuse(peer.peerId, id, "revoked")
    return device
  }
}
