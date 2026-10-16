/**
 * The transports this build of the CLI can run, by channel name.
 *
 * One entry per platform. Each value is a factory, so a transport (and its platform client) is
 * only instantiated when that channel is enabled in `channels.json`; a channel with no entry
 * here shows up in `redrob channels status` as "no transport is available".
 */
import type { ChannelName, TransportFactory } from "@redrob-code/channels-core"
import { discordTransport } from "@redrob-code/channels-discord"
import { slackTransport } from "@redrob-code/channels-slack"
import { telegramTransport } from "@redrob-code/channels-telegram"
import { whatsappTransport } from "@redrob-code/channels-whatsapp"

export const channelFactories: Partial<Record<ChannelName, TransportFactory>> = {
  slack: slackTransport,
  telegram: telegramTransport,
  discord: discordTransport,
  whatsapp: whatsappTransport,
}
