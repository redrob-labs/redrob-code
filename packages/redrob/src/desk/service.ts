/**
 * The desk as the daemon runs it (redrob-mobile `docs/desk-relay.md`, v2 "Daemon local API").
 *
 * One per `redrob serve --register` daemon. It owns the sign-in (RFC 8628 device grant as the
 * `redrob-code` client, polled here so the launcher only opens the link), the on/off switch
 * (`channels.json` entry `desk`, on unless turned off), the pairing store, and the relay
 * connection, which runs while the switch is on and the machine is signed in. The `/desk/*` local
 * routes and `redrob desk ...` call into this.
 */
import { Config, type DaemonConnection } from "@redrob-code/channels-core"
import { endpoints, finishDeviceLogin, startDeviceLogin, type DeviceAuthorization } from "./auth"
import { NotFound, Pairing, type DeviceKind } from "./pairing"
import { DeskRelay, consoleLogger, type Logger } from "./relay"
import { allowAutoAll, machine, updateMachine, type Machine, type MachineUpdate } from "./settings"

export { NotFound }

export type DeskLogin = {
  readonly userCode: string
  readonly verificationUriComplete: string
  readonly expiresAt: number
}

export type DeskDevice = { readonly id: string; readonly name: string; readonly kind: DeviceKind }

export type DeskStatus = {
  readonly enabled: boolean
  readonly signedIn: boolean
  readonly account?: { readonly email: string }
  readonly connected: boolean
  /** The launcher's "Allow Auto all from phone and web" switch (`~/.redrob/desk/settings.json`, missing means on). */
  readonly autoAll: boolean
  readonly login?: DeskLogin
  readonly pending: readonly { code: string; name: string; kind: DeviceKind; expiresAt: number }[]
  readonly devices: readonly { id: string; name: string; kind: DeviceKind; addedAt: number; online: boolean }[]
}

/** The device grant is already running (or this machine is already signed in). */
export class AlreadySignedIn extends Error {}

export class DeskService {
  readonly pairing: Pairing
  private relay?: DeskRelay
  private login?: { readonly device: DeviceAuthorization; readonly abort: AbortController }
  private reconciling: Promise<void> = Promise.resolve()

  constructor(
    private readonly daemon: DaemonConnection,
    private readonly log: Logger = consoleLogger,
    /** Called after the relay starts or stops, so the daemon can re-apply its idle policy. */
    private readonly onChange: () => void = () => {},
  ) {
    this.pairing = new Pairing()
  }

  /** True while the relay connection runs; the daemon stays up for it. */
  get active(): boolean {
    return this.relay !== undefined
  }

  private tokens() {
    return this.pairing.tokens()
  }

  async signedIn(): Promise<boolean> {
    return Boolean(await this.tokens().get("refreshToken"))
  }

  async enabled(): Promise<boolean> {
    return Config.deskEnabled(await Config.load())
  }

  /** Start or stop the relay to match the switch and the sign-in. Calls are serialized. */
  reconcile(): Promise<void> {
    this.reconciling = this.reconciling
      .then(async () => {
        const wanted = (await this.enabled().catch(() => true)) && (await this.signedIn().catch(() => false))
        if (wanted && !this.relay) {
          this.relay = new DeskRelay(this.daemon, this.pairing, this.log)
          this.relay.start()
          this.log.info("relay on")
          this.onChange()
        } else if (!wanted && this.relay) {
          this.relay.stop()
          this.relay = undefined
          this.log.info("relay off")
          this.onChange()
        }
      })
      .catch((error: unknown) => {
        this.log.warn(`reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    return this.reconciling
  }

  stop(): void {
    this.login?.abort.abort()
    this.login = undefined
    this.relay?.stop()
    this.relay = undefined
  }

  async status(): Promise<DeskStatus> {
    const [enabled, signedIn, email, autoAll] = await Promise.all([
      this.enabled().catch(() => true),
      this.signedIn().catch(() => false),
      this.tokens()
        .get("email")
        .catch(() => undefined),
      allowAutoAll(),
    ])
    const relay = this.relay?.status()
    const online = relay?.online ?? new Set<string>()
    const login = this.currentLogin()
    return {
      enabled,
      signedIn,
      ...(signedIn && email ? { account: { email } } : {}),
      connected: relay?.connected ?? false,
      autoAll,
      ...(login ? { login } : {}),
      pending: this.pairing.list().map(({ code, name, kind, expiresAt }) => ({ code, name, kind, expiresAt })),
      devices: (await this.pairing.devices()).map(({ id, name, kind, addedAt }) => ({
        id,
        name,
        kind,
        addedAt,
        online: online.has(id),
      })),
    }
  }

  async enable(enabled: boolean): Promise<DeskStatus> {
    await Config.update((config) => Config.setDesk(config, enabled))
    await this.reconcile()
    return this.status()
  }

  private currentLogin(): DeskLogin | undefined {
    const device = this.login?.device
    if (!device || device.expiresAt <= Date.now()) return undefined
    return {
      userCode: device.userCode,
      verificationUriComplete: device.verificationUriComplete,
      expiresAt: device.expiresAt,
    }
  }

  /**
   * Start the device grant, or hand back the one already running. The daemon polls the token
   * endpoint; on success it stores the refresh token (and the account email) and starts the relay.
   */
  async startLogin(): Promise<DeskLogin> {
    const running = this.currentLogin()
    if (running) return running
    if (await this.signedIn()) throw new AlreadySignedIn("this machine is already signed in")
    const { issuer } = endpoints()
    const device = await startDeviceLogin(issuer)
    const abort = new AbortController()
    const login = { device, abort }
    this.login = login
    void finishDeviceLogin(issuer, device)
      .then(async (tokens) => {
        if (abort.signal.aborted) return
        if (!tokens.refreshToken) throw new Error("redrob-auth returned no refresh token")
        await this.tokens().set("refreshToken", tokens.refreshToken)
        if (tokens.email) await this.tokens().set("email", tokens.email)
        else await this.tokens().delete("email")
        this.log.info("signed in")
        await this.reconcile()
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          this.log.warn(`sign-in failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        if (this.login === login) this.login = undefined
      })
    return {
      userCode: device.userCode,
      verificationUriComplete: device.verificationUriComplete,
      expiresAt: device.expiresAt,
    }
  }

  /** Drop the refresh token and disconnect. Approved devices are kept. */
  async logout(): Promise<DeskStatus> {
    this.login?.abort.abort()
    this.login = undefined
    await this.tokens().delete("refreshToken")
    await this.tokens().delete("email")
    await this.reconcile()
    return this.status()
  }

  async approve(code: string): Promise<DeskDevice> {
    const device = this.relay ? await this.relay.approve(code) : (await this.pairing.approve(code)).device
    return { id: device.id, name: device.name, kind: device.kind }
  }

  deny(code: string): DeskDevice {
    const request = this.relay ? this.relay.deny(code) : this.pairing.deny(code)
    return { id: request.deviceId, name: request.name, kind: request.kind }
  }

  async revoke(id: string): Promise<DeskDevice> {
    const device = this.relay ? await this.relay.revoke(id) : await this.pairing.revoke(id)
    return { id: device.id, name: device.name, kind: device.kind }
  }

  /** This machine (`GET /desk/machine`). */
  machine(): Promise<Machine> {
    return machine()
  }

  /** `POST /desk/machine`: rename, change kind or access; the relay sends a fresh `desk.machine`. */
  async updateMachine(update: MachineUpdate): Promise<Machine> {
    const next = await updateMachine(update)
    this.relay?.machineChanged()
    return next
  }
}
