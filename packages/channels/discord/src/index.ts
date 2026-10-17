/**
 * @redrob-code/channels-discord: the Discord transport for `@redrob-code/channels-core`.
 *
 * ```ts
 * import { discordTransport } from "@redrob-code/channels-discord"
 * // registry.ts:  discord: discordTransport
 * ```
 */
export { DiscordTransport, discordTransport, stripMention, DISCORD_MAX_CHUNK } from "./transport"
