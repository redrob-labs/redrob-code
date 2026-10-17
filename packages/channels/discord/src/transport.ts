/**
 * Discord transport for the Redrob Code channels core, on discord.js.
 *
 * One Discord channel is one conversation: a DM channel, a guild text channel, or a thread (a
 * thread is its own channel id). The sender is the author's user id, which is what the allowlist
 * matches. DMs are always delivered; in guild channels only messages that mention the bot are.
 *
 * Secrets (set with `redrob channels set-secret discord <key>`):
 *   botToken -- the bot token from the Developer Portal's Bot page.
 *
 * The bot needs the **Message Content** privileged gateway intent switched on in the Developer
 * Portal, otherwise every guild message arrives with empty content and nothing reaches the engine.
 */
import type { Transport, TransportContext, TransportFactory } from "@redrob-code/channels-core"
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageType,
  Partials,
  type Message,
  type SendableChannels,
} from "discord.js"

/** Discord's hard limit on a message body. */
export const DISCORD_MAX_CHUNK = 2000

export class DiscordTransport implements Transport {
  readonly name = "discord"
  readonly maxChunk = DISCORD_MAX_CHUNK

  private client?: Client
  private ctx?: TransportContext

  async start(ctx: TransportContext): Promise<void> {
    if (this.client) throw new Error("discord transport is already started")
    this.ctx = ctx
    const token = await ctx.secrets.require("botToken")
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      // DM channels are not in the cache until something happens in them; without this partial a
      // DM's messageCreate is dropped by discord.js before we see it.
      partials: [Partials.Channel],
    })
    this.client = client

    client.on(Events.MessageCreate, (message) => this.inbound(message))
    client.on(Events.Error, (error) => ctx.log.error(`gateway error: ${error.message}`))
    client.on(Events.Warn, (text) => ctx.log.warn(text))
    client.on(Events.ShardDisconnect, (event) => ctx.log.warn(`gateway disconnected (code ${event.code}); reconnecting`))
    client.on(Events.ShardResume, () => ctx.log.info("gateway resumed"))

    // login() resolves once the token is accepted; the ready event follows when the gateway
    // session is up. A bad token rejects login() itself (TokenInvalid), which rejects start().
    const ready = new Promise<void>((resolve, reject) => {
      client.once(Events.ClientReady, () => resolve())
      client.once(Events.Error, (error) => reject(error))
    })
    try {
      await client.login(token)
      await ready
    } catch (error) {
      await client.destroy().catch(() => undefined)
      this.client = undefined
      throw error instanceof Error ? error : new Error(String(error))
    }
    ctx.log.info(`connected as ${client.user?.tag ?? "unknown user"}`)
  }

  async stop(): Promise<void> {
    const client = this.client
    this.client = undefined
    this.ctx = undefined
    if (client) await client.destroy()
  }

  async send(conversationId: string, chunks: readonly string[], replyTo?: string): Promise<void> {
    const channel = await this.sendable(conversationId)
    let first = true
    for (const chunk of chunks) {
      if (first && replyTo) {
        await channel.send({ content: chunk, reply: { messageReference: replyTo, failIfNotExists: false } })
      } else {
        await channel.send({ content: chunk })
      }
      first = false
    }
  }

  async typing(conversationId: string): Promise<void> {
    const channel = await this.sendable(conversationId)
    await channel.sendTyping()
  }

  private async sendable(conversationId: string): Promise<SendableChannels> {
    const client = this.client
    if (!client) throw new Error("discord transport is not started")
    const channel = await client.channels.fetch(conversationId)
    if (!channel) throw new Error(`discord channel ${conversationId} was not found`)
    if (!channel.isSendable()) throw new Error(`discord channel ${conversationId} cannot receive messages`)
    return channel
  }

  private inbound(message: Message): void {
    const ctx = this.ctx
    const client = this.client
    if (!ctx || !client || !client.user) return
    if (message.author.bot || message.author.id === client.user.id) return
    // Only ordinary messages and replies carry a human's text; joins, pins, boosts and the rest
    // are platform noise.
    if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return

    const isDm = message.channel.type === ChannelType.DM
    if (!isDm) {
      // In a guild the bot answers only when it is addressed; `mentions.users` ignores @everyone
      // and role mentions, which `mentions.has` would count.
      if (!message.mentions.users.has(client.user.id)) return
    }

    const text = stripMention(message.content, client.user.id).trim()
    if (text.length === 0) return

    ctx.onMessage({
      channel: this.name,
      conversationId: message.channelId,
      senderId: message.author.id,
      senderName: message.member?.displayName ?? message.author.displayName ?? message.author.username,
      text,
      replyTo: message.id,
    })
  }
}

/** Remove `<@id>` / `<@!id>` mentions of the bot so the prompt is what the human typed. */
export function stripMention(content: string, userId: string): string {
  return content.replaceAll(new RegExp(`<@!?${userId}>`, "g"), " ").replace(/\s{2,}/g, " ")
}

export const discordTransport: TransportFactory = () => new DiscordTransport()
