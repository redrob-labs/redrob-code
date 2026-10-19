/**
 * Channel secrets (bot tokens, app tokens, signing secrets) behind one interface.
 *
 * The file store writes `$HOME/.redrob/channels/secrets.json` with mode 0600 in a 0700 folder:
 * `{ "slack": { "botToken": "…", "appToken": "…" } }`. A keychain-backed store can replace it
 * later without the transports noticing; they only ever see `get(channel, key)`.
 */
import fs from "node:fs/promises"
import path from "node:path"
import * as Paths from "./paths"

export interface SecretStore {
  get(channel: string, key: string): Promise<string | undefined>
  set(channel: string, key: string, value: string): Promise<void>
  delete(channel: string, key: string): Promise<boolean>
  /** Key names stored for a channel, never the values. */
  keys(channel: string): Promise<string[]>
}

type Shape = Record<string, Record<string, string>>

function isShape(value: unknown): value is Shape {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      Object.values(entry as Record<string, unknown>).every((v) => typeof v === "string"),
  )
}

export class FileSecretStore implements SecretStore {
  constructor(private readonly file: string = Paths.secretsFile()) {}

  private async read(): Promise<Shape> {
    const value = await Paths.readJson(this.file)
    return isShape(value) ? value : {}
  }

  private async write(shape: Shape): Promise<void> {
    await Paths.writeJson(this.file, shape, 0o600)
    // The folder is created 0700 by writeJson on first use; an existing folder keeps whatever it
    // had, so tighten it here too.
    await fs.chmod(path.dirname(this.file), 0o700).catch(() => undefined)
  }

  async get(channel: string, key: string): Promise<string | undefined> {
    return (await this.read())[channel]?.[key]
  }

  async set(channel: string, key: string, value: string): Promise<void> {
    const shape = await this.read()
    shape[channel] = { ...shape[channel], [key]: value }
    await this.write(shape)
  }

  async delete(channel: string, key: string): Promise<boolean> {
    const shape = await this.read()
    if (shape[channel]?.[key] === undefined) return false
    const { [key]: _, ...rest } = shape[channel]
    if (Object.keys(rest).length === 0) delete shape[channel]
    else shape[channel] = rest
    await this.write(shape)
    return true
  }

  async keys(channel: string): Promise<string[]> {
    return Object.keys((await this.read())[channel] ?? {}).sort()
  }
}

/** In-memory store, for tests and for a transport started with secrets passed in by hand. */
export class MemorySecretStore implements SecretStore {
  constructor(private readonly shape: Shape = {}) {}
  async get(channel: string, key: string) {
    return this.shape[channel]?.[key]
  }
  async set(channel: string, key: string, value: string) {
    this.shape[channel] = { ...this.shape[channel], [key]: value }
  }
  async delete(channel: string, key: string) {
    if (this.shape[channel]?.[key] === undefined) return false
    delete this.shape[channel][key]
    return true
  }
  async keys(channel: string) {
    return Object.keys(this.shape[channel] ?? {}).sort()
  }
}

/** A view of one channel's secrets, so a transport cannot read another channel's tokens. */
export type ChannelSecrets = {
  get(key: string): Promise<string | undefined>
  /** `get` that throws a readable error when the key was never set. */
  require(key: string): Promise<string>
  keys(): Promise<string[]>
}

export function scoped(store: SecretStore, channel: string): ChannelSecrets {
  return {
    get: (key) => store.get(channel, key),
    require: async (key) => {
      const value = await store.get(channel, key)
      if (value === undefined || value === "") {
        throw new Error(`Secret ${channel}.${key} is not set; run: redrob channels set-secret ${channel} ${key}`)
      }
      return value
    },
    keys: () => store.keys(channel),
  }
}
