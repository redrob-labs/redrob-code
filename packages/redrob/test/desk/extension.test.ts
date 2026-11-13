import { afterEach, describe, expect, test } from "bun:test"
import * as DeskCrypto from "../../src/desk/crypto"
import { decodeAction, decodeControl, encodeAction } from "../../src/desk/frames"
import { BrowserUnavailable, ExtensionLink, type Socket } from "../../src/desk/extension"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The relay room: every frame goes to its target, or to everyone else. */
class Room {
  readonly sockets = new Set<FakeSocket>()

  deliver(from: FakeSocket, data: string | Uint8Array): void {
    let target: string | undefined
    if (typeof data === "string") target = decodeControl(data)?.targetId
    else target = decodeAction(data)?.targetId
    for (const socket of this.sockets) {
      if (socket === from) continue
      if (target && socket.peerId !== target) continue
      const payload = typeof data === "string" ? data : data.slice().buffer
      queueMicrotask(() => socket.emit("message", { data: payload }))
    }
  }
}

class FakeSocket implements Socket {
  readyState = 0
  binaryType = "blob"
  private readonly listeners = new Map<string, Array<(event: any) => void>>()

  constructor(
    readonly room: Room,
    readonly peerId: string,
  ) {
    room.sockets.add(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.emit("open", {})
    })
  }

  send(data: string | Uint8Array): void {
    this.room.deliver(this, data)
  }

  close(): void {
    this.readyState = 3
    this.room.sockets.delete(this)
    this.emit("close", { code: 1000 })
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

/**
 * The Redrob extension's side as redrob-extension `src/remote/relay.ts` does it: announce with
 * `kind: "browser"`, `desk.pending` for an unknown device, `desk.accept` for an allowed one, and a
 * `res` for every sealed `req`.
 */
class FakeExtension {
  readonly socket: FakeSocket
  readonly allowed = new Set<string>()
  readonly requests: Array<{ method: unknown; path: unknown; body?: unknown }> = []
  lastHello?: { peerId: string; pub: Uint8Array; eph: Uint8Array; name: string }
  channel?: DeskCrypto.Channel
  answer: (request: { method: unknown; path: unknown; body?: unknown }) => { status: number; body?: unknown } = () => ({
    status: 200,
    body: { ok: true },
  })

  private constructor(
    room: Room,
    readonly desk: DeskCrypto.KeyPair,
  ) {
    this.socket = new FakeSocket(room, "ext-peer")
    this.socket.addEventListener("open", () => void this.announce())
    this.socket.addEventListener("message", (event: { data: string | ArrayBuffer }) => void this.onData(event.data))
  }

  static async create(room: Room): Promise<FakeExtension> {
    return new FakeExtension(room, await DeskCrypto.generate())
  }

  private send(namespace: string, value: unknown, targetId?: string): void {
    this.socket.send(
      encodeAction({ senderId: "ext-peer", ...(targetId ? { targetId } : {}), namespace }, encoder.encode(JSON.stringify(value))),
    )
  }

  async announce(): Promise<void> {
    this.send("desk.announce", {
      v: 1,
      desk: DeskCrypto.b64url(this.desk.pub),
      deskId: await DeskCrypto.keyId(this.desk.pub),
      name: "Chrome on Windows",
      kind: "browser",
    })
  }

  async approve(): Promise<void> {
    const hello = this.lastHello!
    this.allowed.add(await DeskCrypto.keyId(hello.pub))
    await this.accept()
  }

  deny(): void {
    this.send("desk.denied", { v: 1, reason: "denied" }, this.lastHello!.peerId)
  }

  private async accept(): Promise<void> {
    const hello = this.lastHello!
    const ephemeral = await DeskCrypto.generate()
    this.channel = await DeskCrypto.Channel.create({
      desk: this.desk,
      ephemeral,
      phonePub: hello.pub,
      phoneEph: hello.eph,
      ownPeerId: "ext-peer",
      phonePeerId: hello.peerId,
    })
    this.send("desk.accept", { v: 1, eph: DeskCrypto.b64url(ephemeral.pub) }, hello.peerId)
  }

  private async onData(data: string | ArrayBuffer): Promise<void> {
    if (typeof data === "string") {
      if (decodeControl(data)?.type === "hello") await this.announce()
      return
    }
    const frame = decodeAction(new Uint8Array(data))
    if (!frame) return
    if (frame.namespace === "desk.hello") {
      const hello = JSON.parse(decoder.decode(frame.payload)) as { phone: string; eph: string; name: string; kind: string }
      expect(hello.kind).toBe("web")
      this.lastHello = {
        peerId: frame.senderId,
        pub: DeskCrypto.fromB64url(hello.phone),
        eph: DeskCrypto.fromB64url(hello.eph),
        name: hello.name,
      }
      if (this.allowed.has(await DeskCrypto.keyId(this.lastHello.pub))) await this.accept()
      else this.send("desk.pending", { v: 1 }, frame.senderId)
      return
    }
    if (frame.namespace === "desk.msg" && this.channel) {
      const plain = await this.channel.open(frame.payload)
      if (!plain) return
      const message = JSON.parse(decoder.decode(plain)) as { t: string; id: number; method: unknown; path: unknown; body?: unknown }
      if (message.t !== "req") return
      this.requests.push({ method: message.method, path: message.path, body: message.body })
      const result = this.answer(message)
      const sealed = await this.channel.seal(encoder.encode(JSON.stringify({ t: "res", id: message.id, ...result })))
      this.socket.send(encodeAction({ senderId: "ext-peer", targetId: frame.senderId, namespace: "desk.msg" }, sealed))
    }
  }
}

function secrets() {
  const values = new Map<string, string>()
  return { values, get: async (key: string) => values.get(key), set: async (key: string, value: string) => void values.set(key, value) }
}

const links: ExtensionLink[] = []
afterEach(() => {
  for (const link of links.splice(0)) link.stop()
})

function link(room: Room, store = secrets()) {
  const created = new ExtensionLink(
    { relayTicket: async () => ({ url: "wss://relay.test/r", ticket: "t", expiresAt: "", role: "owner", peerId: "code-peer", room: "desk:u" }) },
    store,
    { name: "Redrob Code on test", socket: () => new FakeSocket(room, "code-peer"), announceWaitMs: 200 },
  )
  links.push(created)
  created.start()
  return created
}

describe("desk crypto, device side", () => {
  test("a device channel and a desk channel read each other, and both sides show the same code", async () => {
    const [desk, device, deskEph, deviceEph] = await Promise.all([
      DeskCrypto.generate(),
      DeskCrypto.generate(),
      DeskCrypto.generate(),
      DeskCrypto.generate(),
    ])
    const deskSide = await DeskCrypto.Channel.create({
      desk,
      ephemeral: deskEph,
      phonePub: device.pub,
      phoneEph: deviceEph.pub,
      ownPeerId: "D",
      phonePeerId: "P",
    })
    const deviceSide = await DeskCrypto.Channel.device({
      device,
      ephemeral: deviceEph,
      deskPub: desk.pub,
      deskEph: deskEph.pub,
      ownPeerId: "P",
      deskPeerId: "D",
    })
    const there = await deskSide.open(await deviceSide.seal(encoder.encode("req")))
    expect(decoder.decode(there!)).toBe("req")
    const back = await deviceSide.open(await deskSide.seal(encoder.encode("res")))
    expect(decoder.decode(back!)).toBe("res")
    expect(await DeskCrypto.devicePairingCode(device, desk.pub)).toBe(await DeskCrypto.pairingCode(desk, device.pub))
  })
})

describe("ExtensionLink", () => {
  test("no browser in the room: unavailable with state none", async () => {
    const room = new Room()
    const subject = link(room)
    const error = await subject.request("GET", "/desk/capabilities").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BrowserUnavailable)
    expect((error as BrowserUnavailable).state).toEqual({ state: "none" })
  })

  test("listens without asking: Chrome gets no pairing request until the first request", async () => {
    const room = new Room()
    const extension = await FakeExtension.create(room)
    const subject = link(room)
    await Bun.sleep(100)
    expect(subject.status()).toEqual({ state: "found", name: "Chrome on Windows" })
    expect(extension.lastHello).toBeUndefined()
  })

  test("first request waits for Allow, then goes through; the pairing is kept", async () => {
    const room = new Room()
    const extension = await FakeExtension.create(room)
    extension.answer = (request) => ({ status: 200, body: { echo: request.path } })
    const store = secrets()
    const subject = link(room, store)
    const pending = subject.request("GET", "/desk/capabilities", undefined, { pairMs: 5_000 })
    await Bun.sleep(150)
    const status = subject.status()
    expect(status.state).toBe("pairing")
    const code = status.state === "pairing" ? status.code : ""
    expect(code).toBe(await DeskCrypto.pairingCode(extension.desk, extension.lastHello!.pub))
    expect(extension.lastHello!.name).toBe("Redrob Code on test")
    await extension.approve()
    expect(await pending).toEqual({ status: 200, body: { echo: "/desk/capabilities" } })
    expect(subject.status()).toEqual({ state: "ready", name: "Chrome on Windows" })
    expect(store.values.get("browserDesk")).toBe(await DeskCrypto.keyId(extension.desk.pub))
    expect(store.values.has("browserKey")).toBe(true)

    // Same key on the next start: the extension knows it and accepts at once.
    subject.stop()
    const again = link(room, store)
    expect((await again.request("POST", "/browser/task", { task: "x" })).status).toBe(200)
    expect(extension.requests.at(-1)).toEqual({ method: "POST", path: "/browser/task", body: { task: "x" } })
  })

  test("no Allow in time: unavailable as pairing, and the next request does not wait again", async () => {
    const room = new Room()
    await FakeExtension.create(room)
    const subject = link(room)
    const first = await subject.request("GET", "/desk/capabilities", undefined, { pairMs: 300 }).catch((e: unknown) => e)
    expect((first as BrowserUnavailable).state.state).toBe("pairing")
    const started = Date.now()
    const second = await subject.request("GET", "/desk/capabilities", undefined, { pairMs: 5_000 }).catch((e: unknown) => e)
    expect((second as BrowserUnavailable).state.state).toBe("pairing")
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("Deny in Chrome: unavailable as denied", async () => {
    const room = new Room()
    const extension = await FakeExtension.create(room)
    const subject = link(room)
    const pending = subject.request("GET", "/desk/capabilities", undefined, { pairMs: 5_000 }).catch((e: unknown) => e)
    await Bun.sleep(150)
    extension.deny()
    const error = await pending
    expect((error as BrowserUnavailable).state).toEqual({ state: "denied", name: "Chrome on Windows", reason: "denied" })
  })
})
