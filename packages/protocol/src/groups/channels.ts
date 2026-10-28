import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, DeskNotFoundError, ServiceUnavailableError } from "../errors"

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

/**
 * The desk relay (redrob-mobile docs/desk-relay.md, v2 section 3): web and phone devices driving
 * this daemon. The launcher polls `desk.status` and answers pending devices.
 */
const DeviceKind = Schema.Literals(["phone", "web"])

export const DeskLogin = Schema.Struct({
  userCode: Schema.String,
  verificationUriComplete: Schema.String,
  expiresAt: Schema.Number,
}).annotate({ identifier: "DeskLogin" })

export const DeskStatus = Schema.Struct({
  /** The switch (`channels.json` entry `desk`); on unless turned off. */
  enabled: Schema.Boolean,
  signedIn: Schema.Boolean,
  account: Schema.optional(Schema.Struct({ email: Schema.String })),
  /** The relay connection is open. */
  connected: Schema.Boolean,
  /** The launcher's "Allow Auto all from phone and web" switch (`~/.redrob/desk/settings.json` `allowAutoAll`, missing means on). */
  autoAll: Schema.optional(Schema.Boolean),
  /** A sign-in started with `desk.login` and still waiting for the person. */
  login: Schema.optional(DeskLogin),
  pending: Schema.Array(
    Schema.Struct({ code: Schema.String, name: Schema.String, kind: DeviceKind, expiresAt: Schema.Number }),
  ),
  devices: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      kind: DeviceKind,
      addedAt: Schema.Number,
      /** Has an open encrypted session right now. */
      online: Schema.Boolean,
    }),
  ),
}).annotate({ identifier: "DeskStatus" })

export const DeskDevice = Schema.Struct({ id: Schema.String, name: Schema.String, kind: DeviceKind }).annotate({
  identifier: "DeskDevice",
})

const MachineKind = Schema.Literals(["desktop", "server", "cloud"])
const MachineAccess = Schema.Literals(["read_only", "ask", "trusted"])

/** This machine as the relay and paired devices see it (`~/.redrob/desk/settings.json` `machine`). */
export const DeskMachine = Schema.Struct({
  /** Made once, never changes. */
  id: Schema.String,
  /** Hostname unless renamed. */
  name: Schema.String,
  kind: MachineKind,
  /** `process.platform`. */
  os: Schema.String,
  /** What phones and the web may do here; `trusted` by default. */
  access: MachineAccess,
}).annotate({ identifier: "DeskMachine" })

export const DeskMachineUpdate = Schema.Struct({
  name: Schema.optional(Schema.String),
  kind: Schema.optional(MachineKind),
  access: Schema.optional(MachineAccess),
}).annotate({ identifier: "DeskMachineUpdate" })

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
        description:
          "The switch, the sign-in, the relay connection, devices waiting for approval (with their codes), and approved devices.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("desk.enable", "/desk/enable", {
      payload: Schema.Struct({ enabled: Schema.Boolean }),
      success: DeskStatus,
      error: ServiceUnavailableError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.desk.enable",
        summary: "Turn the desk relay on or off",
        description:
          "Persisted in channels.json as channel desk. The relay runs while this is on and the machine is signed in. 503 on a server that is not the registered daemon.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("desk.login", "/desk/login", {
      success: DeskLogin,
      error: [ConflictError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.desk.login",
        summary: "Sign this machine in for the desk relay",
        description:
          "Starts the RFC 8628 device grant (or returns the one already running). The daemon polls and stores the token. 409 when already signed in.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("desk.logout", "/desk/logout", {
      success: DeskStatus,
      error: ServiceUnavailableError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.desk.logout",
        summary: "Sign out of the desk relay",
        description: "Drops the refresh token and disconnects. Approved devices are kept.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("desk.approve", "/desk/pending/:code/approve", {
      params: { code: Schema.String },
      success: DeskDevice,
      error: [DeskNotFoundError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.desk.approve",
        summary: "Allow a device",
        description: "Approve the pending device showing this six-digit code. 404 when none matches.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("desk.deny", "/desk/pending/:code/deny", {
      params: { code: Schema.String },
      success: DeskDevice,
      error: [DeskNotFoundError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.desk.deny",
        summary: "Refuse a device",
        description:
          "Deny the pending device showing this six-digit code; it is sent desk.denied. 404 when none matches.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("desk.revoke", "/desk/devices/:id/revoke", {
      params: { id: Schema.String },
      success: DeskDevice,
      error: [DeskNotFoundError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.desk.revoke",
        summary: "Remove an approved device",
        description:
          "Forget an approved device; a connected one is sent desk.denied and dropped. 404 when no device has that id.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("desk.machine.get", "/desk/machine", {
      success: DeskMachine,
      error: ServiceUnavailableError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.desk.machine.get",
        summary: "This machine",
        description:
          "Machine id, name, kind, OS and the access phones and the web have here. 503 on a server that is not the registered daemon.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("desk.machine.update", "/desk/machine", {
      payload: DeskMachineUpdate,
      success: DeskMachine,
      error: ServiceUnavailableError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.desk.machine.update",
        summary: "Rename this machine or change its access",
        description:
          "Fields left out keep their value; an empty name keeps the old one. The relay is told at once. 503 on a server that is not the registered daemon.",
      }),
    ),
  )
