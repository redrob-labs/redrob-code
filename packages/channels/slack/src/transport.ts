/**
 * Slack transport: Bolt in Socket Mode, so nothing has to be reachable from the internet.
 *
 * One Slack thread is one conversation: `conversationId` is `<channel>:<thread_ts>`, where
 * `thread_ts` is the root message's `ts` (a top-level message starts the thread named after
 * itself). Replies always go into that thread. Mentions (`app_mention`), direct messages
 * (`message.im`) and channel messages (`message.channels`, in channels the bot was invited to)
 * are all handed to the core; the bot's own posts, other bots and message subtypes (edits,
 * joins, file shares without text) are dropped here.
 *
 * Secrets, read at `start` from `ctx.secrets`: `botToken` (xoxb-…) and `appToken` (xapp-…, the
 * app-level token with `connections:write`). Nothing is read from the environment.
 */
import { App, LogLevel } from "@slack/bolt"
import type { Inbound, Transport, TransportContext, TransportFactory } from "@redrob-code/channels-core"

/** Slack rejects `chat.postMessage` text past ~4000 characters; keep headroom for formatting. */
export const SLACK_MAX_CHUNK = 3900

/** How many recent event keys to remember for de-duplication (a mention arrives twice). */
const SEEN_LIMIT = 1000

/** The subset of a Slack message event the transport reads; Bolt's unions are wider than needed. */
type MessageLike = {
  readonly type?: string
  readonly subtype?: string
  readonly bot_id?: string
  readonly user?: string
  readonly text?: string
  readonly ts?: string
  readonly thread_ts?: string
  readonly channel?: string
  readonly channel_type?: string
}

export function conversationId(channel: string, ts: string, threadTs?: string): string {
  return `${channel}:${threadTs ?? ts}`
}

/** Split `<channel>:<thread_ts>` back into its halves; a bare channel id has no thread. */
export function splitConversationId(id: string): { channel: string; threadTs?: string } {
  const at = id.indexOf(":")
  if (at < 0) return { channel: id }
  const threadTs = id.slice(at + 1)
  return { channel: id.slice(0, at), ...(threadTs ? { threadTs } : {}) }
}

/** Drop the bot's own mention token(s) from a message so the engine sees the request alone. */
export function stripMention(text: string, botUserId: string | undefined): string {
  if (!botUserId) return text.trim()
  return text.replaceAll(new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g"), "").replace(/\s{2,}/g, " ").trim()
}

export class SlackTransport implements Transport {
  readonly name = "slack"
  readonly maxChunk = SLACK_MAX_CHUNK

  private app?: App
  private ctx?: TransportContext
  private botUserId?: string
  private readonly seen = new Set<string>()
  private readonly names = new Map<string, string>()

  async start(ctx: TransportContext): Promise<void> {
    if (this.app) throw new Error("slack transport is already started")
    this.ctx = ctx
    const token = await ctx.secrets.require("botToken")
    const appToken = await ctx.secrets.require("appToken")

    const app = new App({
      token,
      appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
      // Socket Mode needs no signing secret; Bolt insists on one unless a receiver is given, and
      // the socket-mode receiver is selected by `socketMode`, so any non-empty value satisfies it.
      signingSecret: "unused-in-socket-mode",
    })

    // A bad bot token fails here, before the socket opens, with Slack's own reason (invalid_auth).
    const auth = await app.client.auth.test({ token })
    this.botUserId = typeof auth.user_id === "string" ? auth.user_id : undefined

    app.event("app_mention", async ({ event }) => {
      this.deliver(event as MessageLike)
    })
    app.message(async ({ message }) => {
      this.deliver(message as MessageLike)
    })
    app.error(async (error) => {
      ctx.log.warn(`bolt: ${error.message}`)
    })

    // A bad app token (or one without connections:write) rejects here; Socket Mode reconnects on
    // its own after that, so no loop of ours is needed.
    await app.start()
    this.app = app
    ctx.log.info(`connected as ${this.botUserId ?? "unknown bot user"} (socket mode)`)
  }

  async stop(): Promise<void> {
    const app = this.app
    this.app = undefined
    this.ctx = undefined
    this.seen.clear()
    if (app) await app.stop()
  }

  async send(id: string, chunks: readonly string[], replyTo?: string): Promise<void> {
    const app = this.app
    if (!app) throw new Error("slack transport is not started")
    const { channel, threadTs } = splitConversationId(id)
    const thread_ts = replyTo ?? threadTs
    for (const text of chunks) {
      if (!text) continue
      await app.client.chat.postMessage({ channel, text, ...(thread_ts ? { thread_ts } : {}) })
    }
  }

  // Slack has no typing indicator for classic bots (assistant.threads.setStatus needs the
  // Agents & Assistants feature), so `typing` is intentionally not implemented.

  private deliver(event: MessageLike): void {
    const ctx = this.ctx
    if (!ctx) return
    if (event.bot_id || event.subtype) return
    if (!event.user || !event.channel || !event.ts) return
    if (this.botUserId && event.user === this.botUserId) return
    const text = stripMention(event.text ?? "", this.botUserId)
    if (!text) return

    // A mention in a channel arrives as both app_mention and message.channels; take the first.
    const key = `${event.channel}:${event.ts}`
    if (this.seen.has(key)) return
    this.remember(key)

    const threadTs = event.thread_ts ?? event.ts
    const message: Inbound = {
      channel: this.name,
      conversationId: conversationId(event.channel, event.ts, event.thread_ts),
      senderId: event.user,
      text,
      replyTo: threadTs,
    }
    const cached = this.names.get(event.user)
    if (cached) {
      ctx.onMessage({ ...message, senderName: cached })
      return
    }
    void this.lookupName(event.user).then((name) => {
      ctx.onMessage(name ? { ...message, senderName: name } : message)
    })
  }

  private remember(key: string): void {
    this.seen.add(key)
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
  }

  private async lookupName(user: string): Promise<string | undefined> {
    const app = this.app
    if (!app) return undefined
    try {
      const result = await app.client.users.info({ user })
      const name = result.user?.profile?.display_name || result.user?.real_name || result.user?.name
      if (name) this.names.set(user, name)
      return name || undefined
    } catch {
      // users:read may be missing; the sender id is what the allowlist needs anyway.
      return undefined
    }
  }
}

export const slackTransport: TransportFactory = () => new SlackTransport()
