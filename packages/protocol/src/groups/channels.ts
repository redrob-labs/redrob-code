import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

/**
 * The chat channels this daemon serves (Slack, Telegram, Discord, WhatsApp). The transports run
 * inside `redrob serve --register`; these endpoints let `redrob channels enable|disable|allow`
 * tell a running daemon to re-read `~/.redrob/channels.json`, and let the launcher show which
 * channels are connected. No location: this is about the process, not a project.
 */
export const ChannelStatus = Schema.Struct({
  name: Schema.String,
  enabled: Schema.Boolean,
  connected: Schema.Boolean,
  /** Whether this build has a transport for the channel at all. */
  available: Schema.Boolean,
  lastError: Schema.optional(Schema.String),
  /** The owner: the first allowed sender id. Absent while nobody is allowed. */
  owner: Schema.optional(Schema.String),
  /** True while the channel is waiting for its owner's first message (claim window open). */
  claimOpen: Schema.Boolean,
}).annotate({ identifier: "ChannelStatus" })

export const ChannelStatusList = Schema.Struct({
  channels: Schema.Array(ChannelStatus),
}).annotate({ identifier: "ChannelStatusList" })

export const ChannelReloadResult = Schema.Struct({
  /** Channels running after the reload. */
  running: Schema.Array(Schema.String),
}).annotate({ identifier: "ChannelReloadResult" })

export const ChannelsGroup = HttpApiGroup.make("server.channels")
  .add(
    HttpApiEndpoint.get("channels.status", "/channels/status", { success: ChannelStatusList }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.channels.status",
        summary: "Chat channel status",
        description:
          "Per channel: enabled in channels.json, connected right now, who owns it, whether it is waiting for its owner's first message, and the last error if any.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("channels.reload", "/channels/reload", { success: ChannelReloadResult }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.channels.reload",
        summary: "Re-read channels.json",
        description: "Start newly enabled channels, stop disabled ones, restart changed ones.",
      }),
    ),
  )
