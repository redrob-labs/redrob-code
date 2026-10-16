/**
 * Telegram transport for the Redrob Code channels: grammY, long polling, no webhook.
 *
 * One Telegram chat is one conversation (`conversationId` = chat id). Private chats are always
 * served; in groups and supergroups the bot reacts only to messages that mention it or reply to
 * one of its messages, so a bot sitting in a busy group stays quiet. The sender id is the
 * Telegram user id, which is what the allowlist matches.
 *
 * Secrets (`ctx.secrets`): `botToken` -- the token @BotFather hands out.
 * Options (`ctx.config.options`): `dropPendingUpdates` (boolean, default false) -- discard
 * messages that arrived while the daemon was down instead of answering them on start.
 */
import type { Inbound, Transport, TransportContext, TransportFactory } from "@redrob-code/channels-core"
import { Bot, GrammyError, HttpError, type Context } from "grammy"
import type { MessageEntity, User } from "grammy/types"

/** Telegram's hard limit on a text message. */
export const TELEGRAM_MAX_CHUNK = 4096

/** The secret key names this transport reads. */
export const TELEGRAM_SECRETS = ["botToken"] as const

/** A `sendChatAction("typing")` lasts about five seconds; repeat it until the reply goes out. */
const TYPING_INTERVAL_MS = 4000
/** Stop repeating the indicator even if no reply ever comes. */
const TYPING_MAX_MS = 2 * 60 * 1000

export class TelegramTransport implements Transport {
  readonly name = "telegram"
  readonly maxChunk = TELEGRAM_MAX_CHUNK

  private bot?: Bot
  private ctx?: TransportContext
  private me?: User
  private polling?: Promise<void>
  private readonly typers = new Map<string, { timer: ReturnType<typeof setInterval>; startedAt: number }>()

  async start(ctx: TransportContext): Promise<void> {
    if (this.bot) throw new Error("telegram transport is already started")
    this.ctx = ctx
    const token = await ctx.secrets.require("botToken")
    const bot = new Bot(token)

    bot.on("message:text", (c) => this.inbound(c))
    bot.catch((error) => {
      ctx.log.error(`update ${error.ctx.update.update_id}: ${describe(error.error)}`)
    })

    // getMe: rejects with a 401 GrammyError on a bad token, so a wrong secret fails `start`.
    try {
      await bot.init()
    } catch (error) {
      throw new Error(`Telegram rejected the bot token: ${describe(error)}`)
    }
    this.me = bot.botInfo
    this.bot = bot

    const dropPending = ctx.config.options?.dropPendingUpdates === true
    // grammY's long poller retries on network errors by itself; it only ends when stop() is
    // called or the token is revoked, which `catch` below turns into a log line.
    this.polling = bot
      .start({
        allowed_updates: ["message"],
        drop_pending_updates: dropPending,
        onStart: (info) => ctx.log.info(`connected as @${info.username} (long polling)`),
      })
      .catch((error: unknown) => {
        ctx.log.error(`long polling ended: ${describe(error)}`)
      })
  }

  async stop(): Promise<void> {
    for (const key of [...this.typers.keys()]) this.stopTyping(key)
    const bot = this.bot
    this.bot = undefined
    if (!bot) return
    if (bot.isRunning()) await bot.stop().catch(() => undefined)
    await this.polling
    this.polling = undefined
    this.me = undefined
  }

  async send(conversationId: string, chunks: readonly string[], replyTo?: string): Promise<void> {
    const bot = this.bot
    if (!bot) throw new Error("telegram transport is not started")
    this.stopTyping(conversationId)
    const chatId = Number(conversationId)
    const replyId = replyTo === undefined ? undefined : Number(replyTo)
    let first = true
    for (const chunk of chunks) {
      // Reply to the inbound message with the first chunk only; the rest follow in order.
      const reply =
        first && replyId !== undefined && Number.isFinite(replyId)
          ? { reply_parameters: { message_id: replyId, allow_sending_without_reply: true } }
          : {}
      await bot.api.sendMessage(chatId, chunk, { ...reply, link_preview_options: { is_disabled: true } })
      first = false
    }
  }

  async typing(conversationId: string): Promise<void> {
    const bot = this.bot
    if (!bot) return
    const chatId = Number(conversationId)
    await bot.api.sendChatAction(chatId, "typing")
    if (this.typers.has(conversationId)) return
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (!this.bot || Date.now() - startedAt > TYPING_MAX_MS) {
        this.stopTyping(conversationId)
        return
      }
      this.bot.api.sendChatAction(chatId, "typing").catch(() => this.stopTyping(conversationId))
    }, TYPING_INTERVAL_MS)
    this.typers.set(conversationId, { timer, startedAt })
  }

  private stopTyping(conversationId: string): void {
    const entry = this.typers.get(conversationId)
    if (!entry) return
    clearInterval(entry.timer)
    this.typers.delete(conversationId)
  }

  private inbound(c: Context): void {
    const ctx = this.ctx
    const message = c.message
    const me = this.me
    if (!ctx || !message || !me || typeof message.text !== "string") return
    const from = message.from
    // No sender (channel posts, anonymous admins) or the bot itself: nothing the allowlist can judge.
    if (!from || from.id === me.id || from.is_bot) return

    const group = message.chat.type === "group" || message.chat.type === "supergroup"
    let text = message.text
    if (group) {
      const addressed = this.addressed(message.text, message.entities ?? [], message.reply_to_message?.from, me)
      if (!addressed.yes) return
      text = addressed.text
    }
    text = text.trim()
    if (text.length === 0) return

    const inbound: Inbound = {
      channel: this.name,
      conversationId: String(message.chat.id),
      senderId: String(from.id),
      senderName: from.username ?? [from.first_name, from.last_name].filter(Boolean).join(" "),
      text,
      // Threading only matters in a group, where several people talk; in a private chat a reply
      // quote on every answer is noise.
      ...(group ? { replyTo: String(message.message_id) } : {}),
    }
    ctx.onMessage(inbound)
  }

  /**
   * Whether a group message is for this bot: a `@username` mention, a `text_mention` of the bot,
   * a `/command@username`, or a reply to one of the bot's messages. Returns the text with the
   * mentions removed so `/new@bot` reaches the core as `/new`.
   */
  private addressed(
    text: string,
    entities: readonly MessageEntity[],
    repliedTo: User | undefined,
    me: User,
  ): { yes: boolean; text: string } {
    const username = (me.username ?? "").toLowerCase()
    const cuts: Array<{ start: number; end: number }> = []
    let mentioned = repliedTo?.id === me.id
    for (const entity of entities) {
      // Entity offsets are UTF-16 code units, which is what JavaScript strings index by.
      const start = entity.offset
      const end = entity.offset + entity.length
      const slice = text.slice(start, end)
      if (entity.type === "mention" && username && slice.toLowerCase() === `@${username}`) {
        mentioned = true
        cuts.push({ start, end })
      } else if (entity.type === "text_mention" && entity.user.id === me.id) {
        mentioned = true
        cuts.push({ start, end })
      } else if (entity.type === "bot_command" && username) {
        const at = slice.indexOf("@")
        if (at > 0 && slice.slice(at + 1).toLowerCase() === username) {
          mentioned = true
          // Keep the command, drop only the `@username` suffix.
          cuts.push({ start: start + at, end })
        }
      }
    }
    if (!mentioned) return { yes: false, text }
    let out = ""
    let cursor = 0
    for (const cut of cuts.sort((a, b) => a.start - b.start)) {
      if (cut.start < cursor) continue
      out += text.slice(cursor, cut.start)
      cursor = cut.end
    }
    out += text.slice(cursor)
    return { yes: true, text: out.replace(/\s{2,}/g, " ") }
  }
}

export const telegramTransport: TransportFactory = () => new TelegramTransport()

function describe(error: unknown): string {
  if (error instanceof GrammyError) return `${error.error_code} ${error.description}`
  if (error instanceof HttpError) return `network error: ${error.message}`
  if (error instanceof Error) return error.message
  return String(error)
}
