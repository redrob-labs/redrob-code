import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { AppNotFoundError, InvalidRequestError } from "../errors"

/**
 * The app bridge: a running Redrob desktop app registers its own loopback MCP tool server so the
 * agent can drive the app. The engine connects it as MCP server `app:<name>` for every session,
 * drops it when the app unregisters or stops sending heartbeats, and never writes it to the
 * user's config. docs/APP-BRIDGE.md. No location: this is about the process, not a project.
 */
export const App = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mcpUrl: Schema.String,
  pid: Schema.Number,
  version: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Array(Schema.String)),
  registeredAt: Schema.Number,
  lastSeen: Schema.Number,
}).annotate({ identifier: "BridgedApp" })

export const AppRegistration = Schema.Struct({
  id: Schema.String,
  /** Heartbeat deadline in ms: a registration with no heartbeat for this long is dropped. */
  ttlMs: Schema.Number,
}).annotate({ identifier: "BridgedAppRegistration" })

export const AppList = Schema.Struct({
  apps: Schema.Array(App),
  ttlMs: Schema.Number,
}).annotate({ identifier: "BridgedAppList" })

export const AppRegisterRequest = Schema.Struct({
  name: Schema.String,
  /** The app's MCP server; must be on this machine (127.0.0.1, localhost or [::1]). */
  mcp_url: Schema.String,
  pid: Schema.Number,
  version: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "BridgedAppRegisterRequest" })

export const AppsGroup = HttpApiGroup.make("server.apps")
  .add(
    HttpApiEndpoint.get("apps.list", "/v1/apps", { success: AppList }).annotateMerge(
      OpenApi.annotations({
        identifier: "v1.apps.list",
        summary: "List bridged apps",
        description: "The desktop apps whose MCP tool servers this engine is connected to.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("apps.register", "/v1/apps/register", {
      payload: AppRegisterRequest,
      success: AppRegistration,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v1.apps.register",
        summary: "Bridge an app",
        description:
          "Register the app's loopback MCP server; the engine connects it as `app:<name>` for every session. Send a heartbeat at least every ttlMs/2 while the app runs. 400 when mcp_url is not loopback.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("apps.heartbeat", "/v1/apps/:appID/heartbeat", {
      params: { appID: Schema.String },
      success: App,
      error: AppNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v1.apps.heartbeat",
        summary: "Keep a bridge alive",
        description: "404 when the registration expired or was never made; register again.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("apps.unregister", "/v1/apps/:appID", {
      params: { appID: Schema.String },
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v1.apps.unregister",
        summary: "Unbridge an app",
        description: "The engine disconnects the app's MCP server and forgets the registration.",
      }),
    ),
  )
