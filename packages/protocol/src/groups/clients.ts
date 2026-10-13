import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ClientNotFoundError } from "../errors"

/**
 * Who is attached to this engine. Apps attach when they connect to the shared daemon and send a
 * heartbeat while they run; the daemon exits once nobody has been attached for a while
 * (`redrob serve --register --idle-exit`). The launcher reads the list to show "3 apps attached".
 * No location: this is about the process, not a project.
 */
export const Client = Schema.Struct({
  id: Schema.String,
  app: Schema.String,
  pid: Schema.optional(Schema.Number),
  attachedAt: Schema.Number,
  lastSeen: Schema.Number,
}).annotate({ identifier: "EngineClient" })

export const ClientList = Schema.Struct({
  clients: Schema.Array(Client),
  /** Heartbeat deadline in ms: an attachment with no heartbeat for this long is dropped. */
  ttlMs: Schema.Number,
  /** How long nobody has been attached, in ms; absent while someone is. */
  idleForMs: Schema.optional(Schema.Number),
  /** This daemon's idle policy: exit after this many ms with nobody attached; absent when it stays up. */
  idleExitAfterMs: Schema.optional(Schema.Number),
}).annotate({ identifier: "EngineClientList" })

export const ClientsGroup = HttpApiGroup.make("server.clients")
  .add(
    HttpApiEndpoint.get("clients.list", "/api/clients", { success: ClientList }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.clients.list",
        summary: "List attached apps",
        description: "The apps attached to this engine and how long it has been idle.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("clients.attach", "/api/clients", {
      payload: Schema.Struct({ app: Schema.String, pid: Schema.optional(Schema.Number) }),
      success: Client,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.clients.attach",
        summary: "Attach an app",
        description: "Tell the engine an app depends on it. Send a heartbeat at least every ttlMs/2 while it runs.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("clients.heartbeat", "/api/clients/:clientID/heartbeat", {
      params: { clientID: Schema.String },
      success: Client,
      error: ClientNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.clients.heartbeat",
        summary: "Keep an attachment alive",
        description: "404 when the attachment expired or was never made; attach again.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("clients.detach", "/api/clients/:clientID", {
      params: { clientID: Schema.String },
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.clients.detach",
        summary: "Detach an app",
        description: "The app no longer depends on the engine.",
      }),
    ),
  )
