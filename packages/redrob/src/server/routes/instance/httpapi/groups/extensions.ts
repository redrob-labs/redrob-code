import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, UpstreamError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

/**
 * Routes a host app (Redrob Desktop) calls for features that run inside the engine because the
 * engine holds the credential or the MCP connection:
 *
 * - `POST /experimental/extensions/call`: a named extension action. Today the image extension
 *   (`openai-image-gen`: generate, edit, blend), served through the Redrob gateway on the engine's
 *   Redrob key, the same account the chat is billed to. Failures answer 200 with `ok: false`, so a
 *   host can tell "the engine has no such route" (404) from "the engine refused this call".
 * - `POST /mcp-apps/resolve` and `POST /mcp-apps/call`: an MCP App view (a connector's `ui://`
 *   resource) and a tool call made from inside that view, after the person confirmed it in the host.
 */
export const ExtensionCallPayload = Schema.Struct({
  extensionId: Schema.String,
  action: Schema.String,
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export const ExtensionCallResponse = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.optional(
    Schema.Struct({
      b64: Schema.optional(Schema.String),
      mime: Schema.optional(Schema.String),
      path: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      costUsd: Schema.optional(Schema.Number),
    }),
  ),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "ExtensionCallResponse" })

export const McpAppResolvePayload = Schema.Struct({
  server: Schema.String.annotate({ description: "MCP server name, or the prefix of its projected tool names" }),
  uri: Schema.String.annotate({ description: "The ui:// resource the tool result pointed at" }),
})

export const McpAppResolveResponse = Schema.Struct({
  html: Schema.String,
  mimeType: Schema.optional(Schema.String),
  server: Schema.String,
}).annotate({ identifier: "McpAppResource" })

export const McpAppCallPayload = Schema.Struct({
  server: Schema.String,
  name: Schema.String.annotate({ description: "Tool name as the MCP server knows it" }),
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export const ExtensionsPaths = {
  call: "/experimental/extensions/call",
  mcpAppResolve: "/mcp-apps/resolve",
  mcpAppCall: "/mcp-apps/call",
} as const

export const ExtensionsApi = HttpApi.make("extensions")
  .add(
    HttpApiGroup.make("extensions")
      .add(
        HttpApiEndpoint.post("call", ExtensionsPaths.call, {
          query: WorkspaceRoutingQuery,
          payload: ExtensionCallPayload,
          success: described(ExtensionCallResponse, "The extension's answer"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.extensions.call",
            summary: "Call an extension",
            description: "Run one action of a built-in extension (image generation) with the engine's credential.",
          }),
        ),
        HttpApiEndpoint.post("mcpAppResolve", ExtensionsPaths.mcpAppResolve, {
          query: WorkspaceRoutingQuery,
          payload: McpAppResolvePayload,
          success: described(McpAppResolveResponse, "The app view's HTML"),
          error: [InvalidRequestError, UpstreamError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.app.resolve",
            summary: "Resolve an MCP App view",
            description: "Read a connector's ui:// resource so a host can show it in a sandboxed frame.",
          }),
        ),
        HttpApiEndpoint.post("mcpAppCall", ExtensionsPaths.mcpAppCall, {
          query: WorkspaceRoutingQuery,
          payload: McpAppCallPayload,
          success: described(Schema.Unknown, "The MCP tool result"),
          error: [InvalidRequestError, UpstreamError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.app.call",
            summary: "Call a tool from an MCP App view",
            description: "Call a connector's tool for its app view. The host confirms the call with the person first.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "extensions",
          description: "Extension calls and MCP App views for host apps.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "redrob HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )
