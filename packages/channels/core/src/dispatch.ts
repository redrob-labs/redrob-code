/**
 * From an inbound chat message to an engine session and back.
 *
 * One conversation is one session. The map `(channel, conversationId) -> sessionID` is persisted
 * in `$HOME/.redrob/channels/sessions.json` so a daemon restart continues the same sessions.
 * Messages in one conversation are handled one at a time, in order; conversations run in parallel.
 *
 * Commands: `/new` drops the mapping and starts a fresh session on the next message; `/status`
 * reports the session the conversation is bound to. Anything else is sent as a prompt.
 */
import { createRedrobClient, type RedrobClient } from "@redrob-labs/sdk"
import type { ChannelConfig } from "./config"
import * as Paths from "./paths"
import { DEFAULT_MAX_CHUNK, render } from "./renderer"
import type { DaemonConnection, Inbound, Logger, Transport } from "./transport"

export type Binding = {
  readonly sessionID: string
  readonly directory: string
  readonly createdAt: number
  /** Last time a message went through; informational. */
  readonly lastUsedAt: number
}

type Shape = { version: 1; bindings: Record<string, Binding> }

export function conversationKey(channel: string, conversationId: string): string {
  return `${channel}:${conversationId}`
}

function isBinding(value: unknown): value is Binding {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.sessionID === "string" &&
    typeof v.directory === "string" &&
    typeof v.createdAt === "number" &&
    typeof v.lastUsedAt === "number"
  )
}

/** The persisted conversation -> session map. One instance per daemon; writes are serialised. */
export class SessionMap {
  private bindings: Record<string, Binding> = {}
  private loaded = false
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly file: string = Paths.sessionsFile()) {}

  private async load(): Promise<void> {
    if (this.loaded) return
    const value = (await Paths.readJson(this.file)) as Partial<Shape> | undefined
    if (value && typeof value.bindings === "object" && value.bindings !== null) {
      for (const [key, binding] of Object.entries(value.bindings)) {
        if (isBinding(binding)) this.bindings[key] = binding
      }
    }
    this.loaded = true
  }

  private flush(): Promise<void> {
    const snapshot: Shape = { version: 1, bindings: { ...this.bindings } }
    this.writing = this.writing.then(() => Paths.writeJson(this.file, snapshot, 0o600)).catch(() => undefined)
    return this.writing
  }

  async get(key: string): Promise<Binding | undefined> {
    await this.load()
    return this.bindings[key]
  }

  async set(key: string, binding: Binding): Promise<void> {
    await this.load()
    this.bindings[key] = binding
    await this.flush()
  }

  async delete(key: string): Promise<boolean> {
    await this.load()
    const had = key in this.bindings
    delete this.bindings[key]
    if (had) await this.flush()
    return had
  }

  async touch(key: string): Promise<void> {
    await this.load()
    const current = this.bindings[key]
    if (!current) return
    this.bindings[key] = { ...current, lastUsedAt: Date.now() }
    await this.flush()
  }
}

export type DispatcherOptions = {
  readonly transport: Transport
  readonly config: ChannelConfig
  readonly daemon: DaemonConnection
  readonly sessions: SessionMap
  readonly log: Logger
  /** Project directory for new sessions. */
  readonly directory: string
  readonly fetch?: typeof fetch
}

export const HELP = [
  "Commands:",
  "/new     start a fresh session for this conversation",
  "/status  show which session this conversation is bound to",
  "/help    this text",
].join("\n")

type Part = { type: string; text?: string }

export class Dispatcher {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly clients = new Map<string, RedrobClient>()

  constructor(private readonly o: DispatcherOptions) {}

  private client(directory: string): RedrobClient {
    let client = this.clients.get(directory)
    if (!client) {
      client = createRedrobClient({
        baseUrl: this.o.daemon.url,
        headers: { ...this.o.daemon.headers },
        directory,
        ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
      })
      this.clients.set(directory, client)
    }
    return client
  }

  private get limit(): number {
    return this.o.config.maxChunk ?? this.o.transport.maxChunk ?? DEFAULT_MAX_CHUNK
  }

  /** Queue a message behind the others in its conversation. Never rejects; errors are replied. */
  handle(message: Inbound): Promise<void> {
    const key = conversationKey(message.channel, message.conversationId)
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous
      .then(() => this.process(key, message))
      .catch((error: unknown) => {
        this.o.log.error(`${key}: ${error instanceof Error ? error.message : String(error)}`)
        return this.reply(message, `Something went wrong: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key)
      })
    this.queues.set(key, next)
    return next
  }

  private async reply(message: Inbound, markdown: string): Promise<void> {
    const chunks = render(markdown, this.limit)
    if (chunks.length === 0) return
    await this.o.transport.send(message.conversationId, chunks, message.replyTo)
  }

  private async process(key: string, message: Inbound): Promise<void> {
    const text = message.text.trim()
    if (text.length === 0) return
    const command = /^\/(\w+)\b/.exec(text)?.[1]?.toLowerCase()
    switch (command) {
      case "new": {
        await this.o.sessions.delete(key)
        const binding = await this.create(key, message)
        return this.reply(message, `Started a new session (${binding.sessionID}).`)
      }
      case "status": {
        const binding = await this.o.sessions.get(key)
        if (!binding) return this.reply(message, "No session yet; the next message starts one.")
        return this.reply(
          message,
          [
            `Session: ${binding.sessionID}`,
            `Directory: ${binding.directory}`,
            `Started: ${new Date(binding.createdAt).toISOString()}`,
            `Last used: ${new Date(binding.lastUsedAt).toISOString()}`,
          ].join("\n"),
        )
      }
      case "help":
        return this.reply(message, HELP)
      default:
        return this.prompt(key, message, text)
    }
  }

  private async create(key: string, message: Inbound): Promise<Binding> {
    const directory = this.o.directory
    const client = this.client(directory)
    const title = `${message.channel} ${message.conversationId}`.slice(0, 120)
    const result = await client.session.create({ body: { title } })
    if (result.error || !result.data) {
      throw new Error(`The engine refused to create a session: ${describe(result.error)}`)
    }
    const now = Date.now()
    const binding: Binding = { sessionID: result.data.id, directory, createdAt: now, lastUsedAt: now }
    await this.o.sessions.set(key, binding)
    this.o.log.info(`${key} -> session ${binding.sessionID}`)
    return binding
  }

  private async prompt(key: string, message: Inbound, text: string, retried = false): Promise<void> {
    const binding = (await this.o.sessions.get(key)) ?? (await this.create(key, message))
    const client = this.client(binding.directory)
    await this.o.transport.typing?.(message.conversationId).catch(() => undefined)
    const result = await client.session.prompt({
      path: { id: binding.sessionID },
      body: { parts: [{ type: "text", text }] },
    })
    if (result.error || !result.data) {
      // The session is gone (the engine's store was cleared, or another version rewrote it): bind
      // the conversation to a fresh one and send the message there, once.
      if (!retried && status(result.error) === 404) {
        this.o.log.warn(`${key}: session ${binding.sessionID} is gone; starting a new one`)
        await this.o.sessions.delete(key)
        return this.prompt(key, message, text, true)
      }
      throw new Error(`The engine refused the prompt: ${describe(result.error)}`)
    }
    await this.o.sessions.touch(key)
    const parts = (result.data.parts ?? []) as Part[]
    const answer = parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n")
      .trim()
    const failure = (result.data.info as { error?: { data?: { message?: string } } } | undefined)?.error
    if (answer.length === 0 && failure) {
      return this.reply(message, `The engine reported an error: ${failure.data?.message ?? "unknown"}`)
    }
    return this.reply(message, answer.length > 0 ? answer : "(no reply)")
  }
}

function status(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const e = error as { status?: unknown; response?: { status?: unknown } }
  if (typeof e.status === "number") return e.status
  if (typeof e.response?.status === "number") return e.response.status
  return undefined
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null) {
    const e = error as { data?: { message?: unknown }; message?: unknown; name?: unknown }
    if (typeof e.data?.message === "string") return e.data.message
    if (typeof e.message === "string") return e.message
    if (typeof e.name === "string") return e.name
  }
  return String(error ?? "unknown error")
}
