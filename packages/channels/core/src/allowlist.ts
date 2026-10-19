/**
 * Who may talk to the daemon through a channel: an explicit list of sender IDs per channel.
 *
 * Deny by default. An empty list lets nobody in -- except while the channel is waiting for its
 * owner: `redrob channels enable` (and the launcher) open a claim window (`claimUntil`) when the
 * allowlist is empty, and the FIRST person who messages the bot inside that window becomes the
 * owner. Nobody has to look up their own platform id. Once the window has passed, strangers are
 * told to turn the channel off and on again; once somebody owns it, they are told "not allowed".
 * Either reply goes out once per denied sender per start, and every denial is logged.
 */
import type { ChannelConfig } from "./config"
import type { Inbound, Logger } from "./transport"

export const DENIED_REPLY = "You are not allowed to use this bot."
export const CLAIMED_REPLY =
  "You are now the owner of this bot. Only you can talk to it. Send /new to start a fresh session."
export const UNCLAIMED_REPLY =
  "Nobody owns this bot yet. Turn the channel off and on again in Redrob Launcher, then send a message within 15 minutes."

export type Verdict =
  /** Proceed. `claimed` is set when this very message made the sender the owner. */
  | { allowed: true; claimed?: string }
  | { allowed: false; reply: string | undefined }

export class Allowlist {
  private readonly ids: Set<string>
  private readonly warned = new Set<string>()
  private claimUntil: number | undefined

  constructor(ids: readonly string[], claimUntil?: number) {
    this.ids = new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))
    this.claimUntil = claimUntil
  }

  static fromConfig(config: ChannelConfig): Allowlist {
    return new Allowlist(config.allowlist, config.claimUntil)
  }

  allows(senderId: string): boolean {
    return this.ids.has(senderId.trim())
  }

  get size(): number {
    return this.ids.size
  }

  /** The owner: the first allowed sender. */
  get owner(): string | undefined {
    return this.ids.values().next().value
  }

  /** True while nobody is allowed and the first sender may still claim the channel. */
  claimOpen(now: number = Date.now()): boolean {
    return this.ids.size === 0 && this.claimUntil !== undefined && now < this.claimUntil
  }

  /**
   * Decide about one message. Allowed senders proceed. When nobody is allowed and the claim
   * window is open, the sender is recorded as the owner in memory (the caller persists it with
   * `Config.claim`) and proceeds with `claimed` set so the caller can greet them first. Otherwise
   * the verdict carries the reply to send, only the first time per sender, so a chatty stranger
   * does not get a reply per line.
   */
  check(message: Inbound, log: Logger, now: number = Date.now()): Verdict {
    const senderId = message.senderId.trim()
    if (this.ids.has(senderId)) return { allowed: true }
    const who = `${message.channel} sender ${message.senderId}${message.senderName ? ` (${message.senderName})` : ""} in ${message.conversationId}`
    if (this.claimOpen(now) && senderId.length > 0) {
      this.ids.add(senderId)
      this.claimUntil = undefined
      log.info(`claimed ${message.channel} owner ${senderId}`)
      return { allowed: true, claimed: senderId }
    }
    const first = !this.warned.has(message.senderId)
    this.warned.add(message.senderId)
    log.warn(`denied ${who}`)
    const reply = this.ids.size === 0 ? UNCLAIMED_REPLY : DENIED_REPLY
    return { allowed: false, reply: first ? reply : undefined }
  }
}
