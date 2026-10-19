/**
 * The contract a chat transport (Slack, Telegram, Discord, WhatsApp) implements.
 *
 * A transport knows its network and nothing about sessions: it turns platform events into
 * `Inbound` messages and hands them to `ctx.onMessage`, and it delivers plain-text chunks the
 * dispatcher gives it. Everything else -- who may talk, which session a conversation maps to,
 * how markdown becomes text -- is the core's job, so the four transports stay thin and alike.
 */
import type { ChannelConfig } from "./config"
import type { ChannelSecrets } from "./secrets"

/** A message a transport received, normalised across platforms. */
export type Inbound = {
  /** Transport name, e.g. `slack`. */
  readonly channel: string
  /**
   * The conversation this belongs to, stable for its lifetime: a Slack channel+thread, a Telegram
   * chat id, a Discord channel id, a WhatsApp JID. One conversation is one engine session.
   */
  readonly conversationId: string
  /** Platform user id of the sender; this is what the allowlist matches. */
  readonly senderId: string
  readonly senderName?: string
  readonly text: string
  /** Platform message id to reply to (a thread ts, a message id), when the platform has one. */
  readonly replyTo?: string
}

export type Logger = {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** The daemon the transport talks to: its base URL and the Basic header built from its secret. */
export type DaemonConnection = {
  readonly url: string
  readonly headers: { readonly Authorization: string }
}

export type TransportContext = {
  readonly config: ChannelConfig
  /** This channel's secrets only. */
  readonly secrets: ChannelSecrets
  readonly daemon: DaemonConnection
  readonly log: Logger
  /** Hand every message here. The core replies through `send`; the transport never answers itself. */
  readonly onMessage: (message: Inbound) => void
}

export interface Transport {
  readonly name: string
  /** Longest message the platform accepts; the renderer splits replies to fit. Default 3900. */
  readonly maxChunk?: number
  /** Connect and begin delivering to `ctx.onMessage`. Resolves once connected; rejects on failure. */
  start(ctx: TransportContext): Promise<void>
  stop(): Promise<void>
  /** Deliver chunks in order to a conversation. `replyTo` is the inbound message's `replyTo`. */
  send(conversationId: string, chunks: readonly string[], replyTo?: string): Promise<void>
  /** Show a typing indicator, when the platform has one. */
  typing?(conversationId: string): Promise<void>
}

export type TransportFactory = () => Transport

export const consoleLogger = (name: string): Logger => ({
  info: (m) => console.log(`[channels:${name}] ${m}`),
  warn: (m) => console.warn(`[channels:${name}] ${m}`),
  error: (m) => console.error(`[channels:${name}] ${m}`),
})
