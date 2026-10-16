/**
 * Who may talk to the daemon through a channel: an explicit list of sender IDs per channel.
 *
 * Deny by default. An empty list lets nobody in, so enabling a channel without allowing anyone is
 * safe: the bot connects, answers "not allowed" once per denied sender per start, and logs it.
 */
import type { ChannelConfig } from "./config"
import type { Inbound, Logger } from "./transport"

export const DENIED_REPLY = "You are not allowed to use this bot."

export class Allowlist {
  private readonly ids: Set<string>
  private readonly warned = new Set<string>()

  constructor(ids: readonly string[]) {
    this.ids = new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))
  }

  static fromConfig(config: ChannelConfig): Allowlist {
    return new Allowlist(config.allowlist)
  }

  allows(senderId: string): boolean {
    return this.ids.has(senderId.trim())
  }

  get size(): number {
    return this.ids.size
  }

  /**
   * Decide about one message. Returns the reply to send when the sender is denied (only the
   * first time per sender, so a chatty stranger does not get a reply per line), or undefined when
   * the message may proceed.
   */
  check(message: Inbound, log: Logger): { allowed: true } | { allowed: false; reply: string | undefined } {
    if (this.allows(message.senderId)) return { allowed: true }
    const first = !this.warned.has(message.senderId)
    this.warned.add(message.senderId)
    log.warn(
      `denied ${message.channel} sender ${message.senderId}${message.senderName ? ` (${message.senderName})` : ""} in ${message.conversationId}`,
    )
    return { allowed: false, reply: first ? DENIED_REPLY : undefined }
  }
}
