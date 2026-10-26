/**
 * The chat-channel controller the `/channels/*` handlers call.
 *
 * The transports themselves run in the CLI process (`redrob serve --register`, which owns the
 * `@redrob-code/channels-core` manager); the server package only exposes them over HTTP. The
 * serve command registers the controller after it starts the channels. Plain module state, like
 * `clients.ts`: an embedded or unregistered server has no controller and answers "nothing running".
 */
export type ChannelStatus = {
  readonly name: string
  readonly enabled: boolean
  readonly connected: boolean
  readonly available: boolean
  readonly lastError?: string
  /** First allowed sender; undefined while nobody is allowed. */
  readonly owner?: string
  /** Waiting for the owner's first message. */
  readonly claimOpen: boolean
}

export type Controller = {
  status(): ChannelStatus[] | Promise<ChannelStatus[]>
  /** Re-read the config and reconcile; returns the channels running afterwards. */
  reload(): Promise<string[]>
  /** The desk (web and phone devices -> this daemon). Absent on a server that is not the registered daemon. */
  readonly desk?: DeskController
}

export type DeskKind = "phone" | "web"

export type DeskLogin = { readonly userCode: string; readonly verificationUriComplete: string; readonly expiresAt: number }

export type DeskDevice = { readonly id: string; readonly name: string; readonly kind: DeskKind }

export type DeskStatus = {
  readonly enabled: boolean
  readonly signedIn: boolean
  readonly account?: { readonly email: string }
  readonly connected: boolean
  readonly login?: DeskLogin
  readonly pending: readonly { code: string; name: string; kind: DeskKind; expiresAt: number }[]
  readonly devices: readonly { id: string; name: string; kind: DeskKind; addedAt: number; online: boolean }[]
}

/** No pending request with that code, or no approved device with that id (404). */
export class DeskNotFound extends Error {}

/** `desk.login` on a machine that is already signed in (409). */
export class DeskConflict extends Error {}

/** The `/desk/*` routes, the launcher and `redrob desk ...` through the running daemon. */
export type DeskController = {
  status(): Promise<DeskStatus>
  enable(enabled: boolean): Promise<DeskStatus>
  /** Rejects with `DeskConflict` when already signed in. */
  login(): Promise<DeskLogin>
  logout(): Promise<DeskStatus>
  /** These reject with `DeskNotFound` when nothing matches. */
  approve(code: string): Promise<DeskDevice>
  deny(code: string): Promise<DeskDevice>
  revoke(id: string): Promise<DeskDevice>
}

let controller: Controller | undefined

export function setController(value: Controller | undefined): void {
  controller = value
}

export function current(): Controller | undefined {
  return controller
}
