/**
 * Desk pairing state (redrob-mobile `docs/desk-relay.md`, "Pairing" and "Devices").
 *
 * A device is the phone app or a web browser profile. Kept in the secret store
 * (`~/.redrob/channels/secrets.json`, 0600) under the `desk` scope: `key` is the daemon's
 * long-term P-256 key `D` (private JWK), `devices` the approved devices
 * `[{ id, pub, name, kind, addedAt }]`. v1 stored phones under `phones`; that list is still read,
 * as kind "phone". Nothing about pairing is on the server.
 *
 * Pending requests are memory only: an unknown device's `desk.hello` records one for 10 minutes,
 * and the launcher or `redrob desk approve|deny <code>` answers it.
 */
import { FileSecretStore, type SecretStore } from "@redrob-code/channels-core"
import * as DeskCrypto from "./crypto"

export const SCOPE = "desk"
export const PENDING_MS = 10 * 60_000

export type DeviceKind = "phone" | "web"

export function deviceKind(value: unknown): DeviceKind {
  return value === "web" ? "web" : "phone"
}

export type Device = {
  readonly id: string
  readonly pub: string
  readonly name: string
  readonly kind: DeviceKind
  readonly addedAt: number
}

export type PendingRequest = {
  readonly deviceId: string
  /** The device's long-term public key, base64url. */
  readonly pub: string
  readonly name: string
  readonly kind: DeviceKind
  readonly code: string
  readonly expiresAt: number
  /** The relay peer that asked, so an approval can answer it while it is still in the room. */
  readonly peerId: string
}

/** No pending request with that code, or no paired device with that id. The routes answer 404. */
export class NotFound extends Error {}

export class Pairing {
  private readonly pending = new Map<string, PendingRequest>()
  private desk?: Promise<DeskCrypto.KeyPair>

  constructor(private readonly store: SecretStore = new FileSecretStore()) {}

  /** The secrets of the `desk` scope, for the sign-in token store. */
  tokens() {
    return {
      get: (key: string) => this.store.get(SCOPE, key),
      set: (key: string, value: string) => this.store.set(SCOPE, key, value),
      delete: (key: string) => this.store.delete(SCOPE, key).then(() => undefined),
    }
  }

  /** `D`, created and stored on first use. */
  key(): Promise<DeskCrypto.KeyPair> {
    if (!this.desk) {
      this.desk = (async () => {
        const stored = await this.store.get(SCOPE, "key")
        if (stored) return DeskCrypto.importPrivate(stored)
        const fresh = await DeskCrypto.generate()
        await this.store.set(SCOPE, "key", await DeskCrypto.exportPrivate(fresh))
        return fresh
      })()
      this.desk.catch(() => {
        this.desk = undefined
      })
    }
    return this.desk
  }

  async devices(): Promise<Device[]> {
    const raw = (await this.store.get(SCOPE, "devices")) ?? (await this.store.get(SCOPE, "phones"))
    if (!raw) return []
    try {
      const value = JSON.parse(raw) as unknown
      if (!Array.isArray(value)) return []
      return (value as Partial<Device>[])
        .filter((device) => typeof device?.id === "string" && typeof device.pub === "string")
        .map((device) => ({
          id: device.id!,
          pub: device.pub!,
          name: typeof device.name === "string" ? device.name : "",
          kind: deviceKind(device.kind),
          addedAt: typeof device.addedAt === "number" ? device.addedAt : 0,
        }))
    } catch {
      return []
    }
  }

  private async saveDevices(devices: Device[]): Promise<void> {
    await this.store.set(SCOPE, "devices", JSON.stringify(devices))
    await this.store.delete(SCOPE, "phones").catch(() => undefined)
  }

  async device(id: string): Promise<Device | undefined> {
    return (await this.devices()).find((device) => device.id === id)
  }

  /** Record (or refresh) a request for an unknown device. Returns it with its code. */
  async request(input: {
    devicePub: Uint8Array
    name: string
    kind: DeviceKind
    peerId: string
    now?: number
  }): Promise<PendingRequest> {
    const now = input.now ?? Date.now()
    this.sweep(now)
    const deviceId = await DeskCrypto.keyId(input.devicePub)
    const code = await DeskCrypto.pairingCode(await this.key(), input.devicePub)
    const existing = this.pending.get(code)
    const request: PendingRequest = {
      deviceId,
      pub: DeskCrypto.b64url(input.devicePub),
      name: input.name.slice(0, 100),
      kind: input.kind,
      code,
      // A device that says hello again keeps its original deadline.
      expiresAt: existing?.deviceId === deviceId ? existing.expiresAt : now + PENDING_MS,
      peerId: input.peerId,
    }
    this.pending.set(code, request)
    return request
  }

  /** Drop expired requests and return them, so the relay can tell those devices. */
  sweep(now = Date.now()): PendingRequest[] {
    const expired: PendingRequest[] = []
    for (const [code, request] of this.pending) {
      if (request.expiresAt > now) continue
      this.pending.delete(code)
      expired.push(request)
    }
    return expired
  }

  list(now = Date.now()): PendingRequest[] {
    return [...this.pending.values()].filter((request) => request.expiresAt > now)
  }

  private take(code: string): PendingRequest {
    const digits = code.replace(/\D/g, "")
    const request = this.pending.get(digits)
    if (!request || request.expiresAt <= Date.now()) throw new NotFound(`no pending request with code ${code}`)
    this.pending.delete(digits)
    return request
  }

  async approve(code: string, now = Date.now()): Promise<{ request: PendingRequest; device: Device }> {
    const request = this.take(code)
    const device: Device = { id: request.deviceId, pub: request.pub, name: request.name, kind: request.kind, addedAt: now }
    const devices = (await this.devices()).filter((known) => known.id !== device.id)
    await this.saveDevices([...devices, device])
    return { request, device }
  }

  deny(code: string): PendingRequest {
    return this.take(code)
  }

  async revoke(id: string): Promise<Device> {
    const devices = await this.devices()
    const device = devices.find((known) => known.id === id)
    if (!device) throw new NotFound(`no paired device ${id}`)
    await this.saveDevices(devices.filter((known) => known.id !== id))
    return device
  }
}
