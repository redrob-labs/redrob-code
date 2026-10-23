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
  /** The desk relay's pairing surface; undefined while the relay is not running. */
  desk?(): DeskController | undefined
}

export type DeskStatus = {
  readonly connected: boolean
  readonly pending: readonly { phoneId: string; name: string; code: string; expiresAt: number }[]
  readonly phones: readonly { id: string; name: string; addedAt: number; online: boolean }[]
}

/** `redrob mobile pending|approve|deny|list|revoke` through the running daemon. */
export type DeskController = {
  status(): Promise<DeskStatus>
  /** Rejects when no pending request has that code. */
  reply(code: string, decision: "approve" | "deny"): Promise<{ id: string; name: string }>
  /** Rejects when no phone has that id. */
  revoke(id: string): Promise<{ id: string; name: string }>
}

let controller: Controller | undefined

export function setController(value: Controller | undefined): void {
  controller = value
}

export function current(): Controller | undefined {
  return controller
}
