import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"

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

/** The desk relay (redrob-mobile docs/desk-relay.md): phones waiting to pair, and paired phones. */
export const DeskStatus = Schema.Struct({
  /** False when the desk relay is not running (not signed in, or not a registered daemon). */
  running: Schema.Boolean,
  connected: Schema.Boolean,
  pending: Schema.Array(
    Schema.Struct({ phoneId: Schema.String, name: Schema.String, code: Schema.String, expiresAt: Schema.Number }),
  ),
  phones: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, addedAt: Schema.Number, online: Schema.Boolean }),
  ),
}).annotate({ identifier: "DeskStatus" })

export const DeskPhone = Schema.Struct({ id: Schema.String, name: Schema.String }).annotate({
  identifier: "DeskPhone",
})

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
  .add(
    HttpApiEndpoint.get("desk.status", "/desk/status", { success: DeskStatus }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.desk.status",
        summary: "Desk relay status",
        description: "Whether the desk relay is connected, phones waiting to pair (with their codes), and paired phones.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("desk.reply", "/desk/pairings/reply", {
      payload: Schema.Struct({ code: Schema.String, decision: Schema.Literals(["approve", "deny"]) }),
      success: DeskPhone,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.desk.reply",
        summary: "Approve or deny a phone",
        description: "Answer the pending pairing request whose six-digit code matches. 400 when none matches.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("desk.revoke", "/desk/phones/revoke", {
      payload: Schema.Struct({ id: Schema.String }),
      success: DeskPhone,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.desk.revoke",
        summary: "Unpair a phone",
        description: "Forget a paired phone; a connected one is sent desk.denied and dropped.",
      }),
    ),
  )
