/**
 * `$HOME/.redrob/channels.json`: which chat channels the daemon serves and who may talk to it.
 *
 * Non-secret fields only. Tokens live in the secret store (`secrets.ts`) so this file can be read,
 * diffed and backed up without leaking anything.
 *
 * ```json
 * {
 *   "version": 1,
 *   "directory": "/path/the/sessions/work/in",
 *   "channels": {
 *     "slack":    { "enabled": true,  "allowlist": ["U0123ABC"] },
 *     "telegram": { "enabled": true,  "allowlist": [], "claimUntil": 1760000000000 }
 *   }
 * }
 * ```
 *
 * `claimUntil` is the owner claim window: while it is in the future and the allowlist is empty,
 * the first person who messages the bot is written into the allowlist and the field is removed.
 */
import * as Paths from "./paths"

export const CHANNEL_NAMES = ["slack", "telegram", "discord", "whatsapp"] as const
export type ChannelName = (typeof CHANNEL_NAMES)[number]

export function isChannelName(value: string): value is ChannelName {
  return (CHANNEL_NAMES as readonly string[]).includes(value)
}

export type ChannelConfig = {
  readonly enabled: boolean
  /**
   * Sender IDs allowed to talk to the daemon. Empty means nobody -- unless a claim window is open,
   * in which case the first sender becomes the owner (`claimUntil`).
   */
  readonly allowlist: readonly string[]
  /**
   * Epoch ms until which an empty allowlist may be claimed by the first person who messages the
   * bot. Set by `openClaim` when a channel is enabled with nobody allowed; cleared by the claim.
   */
  readonly claimUntil?: number
  /** Project directory the channel's sessions work in; falls back to the file-level `directory`. */
  readonly directory?: string
  /** Longest reply chunk this channel accepts; the renderer splits at this many characters. */
  readonly maxChunk?: number
  /** Transport-specific, non-secret settings (Stage 2 transports read their own keys). */
  readonly options?: Readonly<Record<string, unknown>>
}

export type ChannelsConfig = {
  readonly version: 1
  /** Default project directory for every channel's sessions. Default: the user's home. */
  readonly directory?: string
  readonly channels: Partial<Readonly<Record<ChannelName, ChannelConfig>>>
}

export const EMPTY: ChannelsConfig = { version: 1, channels: {} }

export function defaultChannel(): ChannelConfig {
  return { enabled: false, allowlist: [] }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function channel(value: unknown): ChannelConfig | undefined {
  if (!isObject(value)) return undefined
  const allowlist = Array.isArray(value.allowlist)
    ? value.allowlist.filter((item): item is string => typeof item === "string")
    : []
  return {
    enabled: value.enabled === true,
    allowlist,
    ...(typeof value.claimUntil === "number" && Number.isFinite(value.claimUntil) ? { claimUntil: value.claimUntil } : {}),
    ...(typeof value.directory === "string" ? { directory: value.directory } : {}),
    ...(typeof value.maxChunk === "number" && value.maxChunk > 0 ? { maxChunk: value.maxChunk } : {}),
    ...(isObject(value.options) ? { options: value.options } : {}),
  }
}

/** Coerce anything into a config; unknown channels and malformed entries are dropped. */
export function parse(value: unknown): ChannelsConfig {
  if (!isObject(value)) return EMPTY
  const channels: Partial<Record<ChannelName, ChannelConfig>> = {}
  if (isObject(value.channels)) {
    for (const [name, entry] of Object.entries(value.channels)) {
      if (!isChannelName(name)) continue
      const parsed = channel(entry)
      if (parsed) channels[name] = parsed
    }
  }
  return {
    version: 1,
    ...(typeof value.directory === "string" ? { directory: value.directory } : {}),
    channels,
  }
}

export async function load(env: NodeJS.ProcessEnv = process.env): Promise<ChannelsConfig> {
  return parse(await Paths.readJson(Paths.configFile(env)))
}

export async function save(config: ChannelsConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await Paths.writeJson(Paths.configFile(env), parse(config), 0o644)
}

/** Read, apply, write; returns the saved config. */
export async function update(
  fn: (current: ChannelsConfig) => ChannelsConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChannelsConfig> {
  const next = parse(fn(await load(env)))
  await save(next, env)
  return next
}

export function setChannel(config: ChannelsConfig, name: ChannelName, patch: Partial<ChannelConfig>): ChannelsConfig {
  const current = config.channels[name] ?? defaultChannel()
  return { ...config, channels: { ...config.channels, [name]: { ...current, ...patch } } }
}

/** How long after enabling a channel with nobody allowed the first sender may claim it. */
export const CLAIM_WINDOW_MS = 15 * 60_000

function withoutClaim(config: ChannelConfig): ChannelConfig {
  const { claimUntil: _dropped, ...rest } = config
  return rest
}

/**
 * Turn a channel on. With an empty allowlist this also opens the owner claim window: the first
 * person to message the bot within `CLAIM_WINDOW_MS` becomes the only allowed sender. With an
 * allowlist already set, any stale window is dropped.
 */
export function openClaim(config: ChannelsConfig, name: ChannelName, now: number = Date.now()): ChannelsConfig {
  const current = withoutClaim(config.channels[name] ?? defaultChannel())
  const next: ChannelConfig =
    current.allowlist.length === 0 ? { ...current, enabled: true, claimUntil: now + CLAIM_WINDOW_MS } : { ...current, enabled: true }
  return { ...config, channels: { ...config.channels, [name]: next } }
}

/** True while nobody is allowed and the claim window has not passed. */
export function claimOpen(config: ChannelConfig | undefined, now: number = Date.now()): boolean {
  return !!config && config.allowlist.length === 0 && typeof config.claimUntil === "number" && now < config.claimUntil
}

/** The owner: the first allowed sender, or undefined while nobody is. */
export function owner(config: ChannelConfig | undefined): string | undefined {
  return config?.allowlist[0]
}

/** Record `senderId` as the owner: first in the allowlist, and the claim window closes. */
export function claim(config: ChannelsConfig, name: ChannelName, senderId: string): ChannelsConfig {
  const current = withoutClaim(config.channels[name] ?? defaultChannel())
  const allowlist = [...new Set([senderId, ...current.allowlist])]
  return { ...config, channels: { ...config.channels, [name]: { ...current, allowlist } } }
}

export function enabledChannels(config: ChannelsConfig): ChannelName[] {
  return CHANNEL_NAMES.filter((name) => config.channels[name]?.enabled === true)
}
