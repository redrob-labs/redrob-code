/**
 * @redrob-code/channels-core: run chat transports against the shared daemon.
 *
 * `startEnabledChannels(factories)` reads `channels.json`, starts a transport for every enabled
 * channel that has a factory, attaches each to the daemon as `channel:<name>` so it is counted as
 * a client, and wires inbound messages through the allowlist to the dispatcher. `reload()`
 * re-reads the file and starts, stops or restarts transports to match. `stopAll()` tears down.
 *
 * Plain promises, no Effect: this runs inside `redrob serve --register` next to the server, and
 * must also be driveable from a test or a one-off script.
 */
import os from "node:os"
import { attach as attachToDaemon, currentDaemon, type Attachment } from "@redrob-labs/sdk/daemon"
import { Allowlist } from "./allowlist"
import * as Config from "./config"
import { Dispatcher, SessionMap } from "./dispatch"
import { FileSecretStore, scoped, type SecretStore } from "./secrets"
import { consoleLogger, type DaemonConnection, type Inbound, type Logger, type Transport, type TransportFactory } from "./transport"

export * as Config from "./config"
export * as Paths from "./paths"
export * as Renderer from "./renderer"
export { Allowlist, DENIED_REPLY } from "./allowlist"
export { Dispatcher, SessionMap, conversationKey, HELP, type Binding, type DispatcherOptions } from "./dispatch"
export { FileSecretStore, MemorySecretStore, scoped, type SecretStore, type ChannelSecrets } from "./secrets"
export {
  consoleLogger,
  type DaemonConnection,
  type Inbound,
  type Logger,
  type Transport,
  type TransportContext,
  type TransportFactory,
} from "./transport"
export type { ChannelConfig, ChannelName, ChannelsConfig } from "./config"

export type ChannelStatus = {
  readonly name: Config.ChannelName
  readonly enabled: boolean
  readonly connected: boolean
  readonly lastError?: string
  /** Whether a transport for this channel is compiled in at all. */
  readonly available: boolean
}

export type ManagerOptions = {
  /** The daemon transports talk to. Default: the registered daemon from `server.json`. */
  readonly daemon?: DaemonConnection
  readonly secrets?: SecretStore
  readonly sessions?: SessionMap
  readonly env?: NodeJS.ProcessEnv
  readonly log?: (name: string) => Logger
  readonly fetch?: typeof fetch
}

type Running = {
  readonly name: Config.ChannelName
  readonly config: Config.ChannelConfig
  readonly transport: Transport
  readonly dispatcher: Dispatcher
  readonly allowlist: Allowlist
  attachment?: Attachment
  connected: boolean
  lastError?: string
}

export class ChannelManager {
  private readonly running = new Map<Config.ChannelName, Running>()
  private readonly errors = new Map<Config.ChannelName, string>()
  private factories: Partial<Record<Config.ChannelName, TransportFactory>> = {}
  private config: Config.ChannelsConfig = Config.EMPTY
  private readonly secrets: SecretStore
  private readonly sessions: SessionMap
  private readonly env: NodeJS.ProcessEnv
  private readonly logger: (name: string) => Logger
  private daemon?: DaemonConnection
  private busy: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: ManagerOptions = {}) {
    this.env = options.env ?? process.env
    this.secrets = options.secrets ?? new FileSecretStore()
    this.sessions = options.sessions ?? new SessionMap()
    this.logger = options.log ?? consoleLogger
    this.daemon = options.daemon
  }

  /** Serialise start/stop/reload so two reloads cannot race one transport. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.busy.then(fn, fn)
    this.busy = next.catch(() => undefined)
    return next
  }

  private async connection(): Promise<DaemonConnection> {
    if (this.daemon) return this.daemon
    const found = await currentDaemon({ env: this.env, ...(this.options.fetch ? { fetch: this.options.fetch } : {}) })
    if (!found) throw new Error("No registered Redrob daemon is running (redrob service start)")
    this.daemon = { url: found.url, headers: found.headers }
    return this.daemon
  }

  /**
   * Read `channels.json` and start every enabled channel that has a factory. Returns the names
   * that are running afterwards. A channel that fails to start is recorded in `status()` and does
   * not stop the others.
   */
  startEnabledChannels(factories: Partial<Record<Config.ChannelName, TransportFactory>>): Promise<Config.ChannelName[]> {
    return this.serial(async () => {
      this.factories = factories
      this.config = await Config.load(this.env)
      await this.apply()
      return [...this.running.keys()]
    })
  }

  /** Re-read `channels.json`; start newly enabled channels, stop disabled ones, restart changed ones. */
  reload(): Promise<Config.ChannelName[]> {
    return this.serial(async () => {
      this.config = await Config.load(this.env)
      await this.apply()
      return [...this.running.keys()]
    })
  }

  stopAll(): Promise<void> {
    return this.serial(async () => {
      for (const name of [...this.running.keys()]) await this.stopOne(name)
    })
  }

  /** True while at least one transport is running, which is when the daemon must not idle-exit. */
  get active(): boolean {
    return this.running.size > 0
  }

  status(): ChannelStatus[] {
    return Config.CHANNEL_NAMES.map((name) => {
      const entry = this.config.channels[name]
      const run = this.running.get(name)
      const lastError = run?.lastError ?? this.errors.get(name)
      return {
        name,
        enabled: entry?.enabled === true,
        connected: run?.connected === true,
        available: this.factories[name] !== undefined,
        ...(lastError ? { lastError } : {}),
      }
    })
  }

  private async apply(): Promise<void> {
    const wanted = Config.enabledChannels(this.config)
    for (const name of [...this.running.keys()]) {
      const run = this.running.get(name)!
      const next = this.config.channels[name]
      const changed = !next?.enabled || JSON.stringify(next) !== JSON.stringify(run.config)
      if (changed) await this.stopOne(name)
    }
    for (const name of wanted) {
      if (this.running.has(name)) continue
      await this.startOne(name, this.config.channels[name]!)
    }
  }

  private async startOne(name: Config.ChannelName, config: Config.ChannelConfig): Promise<void> {
    const log = this.logger(name)
    const factory = this.factories[name]
    if (!factory) {
      this.errors.set(name, "no transport is available for this channel in this build")
      log.warn(`enabled but no transport is registered; skipping`)
      return
    }
    let daemon: DaemonConnection
    try {
      daemon = await this.connection()
    } catch (error) {
      this.errors.set(name, error instanceof Error ? error.message : String(error))
      log.error(this.errors.get(name)!)
      return
    }
    const transport = factory()
    const allowlist = Allowlist.fromConfig(config)
    const directory = config.directory ?? this.config.directory ?? os.homedir()
    const dispatcher = new Dispatcher({
      transport,
      config,
      daemon,
      sessions: this.sessions,
      log,
      directory,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    })
    const run: Running = { name, config, transport, dispatcher, allowlist, connected: false }
    const onMessage = (message: Inbound) => {
      const verdict = allowlist.check(message, log)
      if (!verdict.allowed) {
        if (verdict.reply) void transport.send(message.conversationId, [verdict.reply], message.replyTo).catch(() => undefined)
        return
      }
      void dispatcher.handle(message)
    }
    try {
      await transport.start({ config, secrets: scoped(this.secrets, name), daemon, log, onMessage })
      run.connected = true
      this.errors.delete(name)
      try {
        // The SDK's attach() reads only url and headers; the record it types is not needed here
        // and the daemon's secret is already inside the Authorization header.
        const connection = daemon as Parameters<typeof attachToDaemon>[0]
        run.attachment = await attachToDaemon(connection, `channel:${name}`, {
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        })
      } catch (error) {
        // Not fatal: the daemon only uses attachments for idle accounting, and serve.ts turns idle
        // exit off while channels run anyway.
        log.warn(`could not attach to the daemon as a client: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (allowlist.size === 0) log.warn("allowlist is empty: every sender will be denied")
      log.info(`started (directory ${directory})`)
    } catch (error) {
      run.lastError = error instanceof Error ? error.message : String(error)
      this.errors.set(name, run.lastError)
      log.error(`failed to start: ${run.lastError}`)
      await transport.stop().catch(() => undefined)
      return
    }
    this.running.set(name, run)
  }

  private async stopOne(name: Config.ChannelName): Promise<void> {
    const run = this.running.get(name)
    if (!run) return
    this.running.delete(name)
    const log = this.logger(name)
    await run.attachment?.detach().catch(() => undefined)
    try {
      await run.transport.stop()
      log.info("stopped")
    } catch (error) {
      log.warn(`stop failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** The one manager a process uses; serve.ts and the server's /channels handlers share it. */
let shared: ChannelManager | undefined

export function manager(options?: ManagerOptions): ChannelManager {
  if (!shared) shared = new ChannelManager(options)
  return shared
}

export function startEnabledChannels(
  factories: Partial<Record<Config.ChannelName, TransportFactory>>,
  options?: ManagerOptions,
): Promise<Config.ChannelName[]> {
  return manager(options).startEnabledChannels(factories)
}

export function stopAll(): Promise<void> {
  return shared ? shared.stopAll() : Promise.resolve()
}

export function reload(): Promise<Config.ChannelName[]> {
  return shared ? shared.reload() : Promise.resolve([])
}
