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
}

export type Controller = {
  status(): ChannelStatus[] | Promise<ChannelStatus[]>
  /** Re-read the config and reconcile; returns the channels running afterwards. */
  reload(): Promise<string[]>
}

let controller: Controller | undefined

export function setController(value: Controller | undefined): void {
  controller = value
}

export function current(): Controller | undefined {
  return controller
}
