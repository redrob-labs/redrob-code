/**
 * The transports this build of the CLI can run, by channel name.
 *
 * Stage 1 ships the core and no transports, so the map is empty: an enabled channel in
 * `channels.json` shows up in `redrob channels status` as "no transport is available". Stage 2
 * adds one entry per platform, each a lazy factory so a platform SDK is only loaded when its
 * channel is enabled:
 *
 * ```ts
 * slack: () => new SlackTransport(),
 * ```
 */
import type { ChannelName, TransportFactory } from "@redrob-code/channels-core"

export const channelFactories: Partial<Record<ChannelName, TransportFactory>> = {}
