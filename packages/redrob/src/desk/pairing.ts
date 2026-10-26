/**
 * Desk pairing state (redrob-mobile `docs/desk-relay.md`, "Pairing").
 *
 * Kept in the secret store (`~/.redrob/channels/secrets.json`, 0600) under the `desk` scope:
 * `key` is the daemon's long-term P-256 key `D` (private JWK), `phones` the approved phones
 * `[{ id, pub, name, addedAt }]`. Nothing about pairing is on the server.
 *
 * Pending requests are memory only: an unknown phone's `desk.hello` records one for 10 minutes,
 * and `redrob mobile approve|deny <code>` answers it.
 */
import { FileSecretStore, type SecretStore } from "@redrob-code/channels-core"
import * as DeskCrypto from "./crypto"

export const SCOPE = "desk"
export const PENDING_MS = 10 * 60_000

export type Phone = { readonly id: string; readonly pub: string; readonly name: string; readonly addedAt: number }

export type PendingRequest = {
  readonly phoneId: string
  /** P_pub, base64url. */
  readonly pub: string
  readonly name: string
  readonly code: string
  readonly expiresAt: number
  /** The relay peer that asked, so an approval can answer it while it is still in the room. */
  readonly peerId: string
}

export class Pairing {
  private readonly pending = new Map<string, PendingRequest>()
  private desk?: Promise<DeskCrypto.KeyPair>

  constructor(private readonly store: SecretStore = new FileSecretStore()) {}

  /** The secrets of the `desk` scope, for the sign-in token store. */
  tokens() {
    return {
      get: (key: string) => this.store.get(SCOPE, key),
      set: (key: string, value: string) => this.store.set(SCOPE, key, value),
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

  async phones(): Promise<Phone[]> {
    const raw = await this.store.get(SCOPE, "phones")
    if (!raw) return []
    try {
      const value = JSON.parse(raw) as unknown
      return Array.isArray(value) ? (value as Phone[]).filter((phone) => typeof phone?.id === "string") : []
    } catch {
      return []
    }
  }

  private async savePhones(phones: Phone[]): Promise<void> {
    await this.store.set(SCOPE, "phones", JSON.stringify(phones))
  }

  async phone(id: string): Promise<Phone | undefined> {
    return (await this.phones()).find((phone) => phone.id === id)
  }

  /** Record (or refresh) a request for an unknown phone. Returns it with its code. */
  async request(input: { phonePub: Uint8Array; name: string; peerId: string; now?: number }): Promise<PendingRequest> {
    const now = input.now ?? Date.now()
    this.sweep(now)
    const phoneId = await DeskCrypto.keyId(input.phonePub)
    const code = await DeskCrypto.pairingCode(await this.key(), input.phonePub)
    const existing = this.pending.get(code)
    const request: PendingRequest = {
      phoneId,
      pub: DeskCrypto.b64url(input.phonePub),
      name: input.name.slice(0, 100),
      code,
      // A phone that says hello again keeps its original deadline.
      expiresAt: existing?.phoneId === phoneId ? existing.expiresAt : now + PENDING_MS,
      peerId: input.peerId,
    }
    this.pending.set(code, request)
    return request
  }

  /** Drop expired requests and return them, so the relay can tell those phones. */
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
    if (!request || request.expiresAt <= Date.now()) throw new Error(`no pending request with code ${code}`)
    this.pending.delete(digits)
    return request
  }

  async approve(code: string, now = Date.now()): Promise<{ request: PendingRequest; phone: Phone }> {
    const request = this.take(code)
    const phone: Phone = { id: request.phoneId, pub: request.pub, name: request.name, addedAt: now }
    const phones = (await this.phones()).filter((known) => known.id !== phone.id)
    await this.savePhones([...phones, phone])
    return { request, phone }
  }

  deny(code: string): PendingRequest {
    return this.take(code)
  }

  async revoke(id: string): Promise<Phone> {
    const phones = await this.phones()
    const phone = phones.find((known) => known.id === id)
    if (!phone) throw new Error(`no paired phone ${id}`)
    await this.savePhones(phones.filter((known) => known.id !== id))
    return phone
  }
}
