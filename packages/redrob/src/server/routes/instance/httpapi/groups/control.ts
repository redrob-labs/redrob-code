import { Auth } from "@/auth"

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, ServiceUnavailableError, TimeoutError, UpstreamError } from "../errors"
import { described } from "./metadata"
import { ProviderV2 } from "@redrob-code/core/provider"

const AuthParams = Schema.Struct({
  providerID: ProviderV2.ID,
})

const LogQuery = Schema.Struct({
  directory: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
})

export const LogInput = Schema.Struct({
  service: Schema.String.annotate({ description: "Service name for the log entry" }),
  level: Schema.Union([
    Schema.Literal("debug"),
    Schema.Literal("info"),
    Schema.Literal("error"),
    Schema.Literal("warn"),
  ]).annotate({ description: "Log level" }),
  message: Schema.String.annotate({ description: "Log message" }),
  extra: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Additional metadata for the log entry",
  }),
})

export const SpeechInput = Schema.Struct({
  text: Schema.String.annotate({ description: "The words to speak, at most 4096 characters" }),
  voice: Schema.optional(Schema.String).annotate({ description: "A voice of the chosen model" }),
  model: Schema.optional(Schema.String).annotate({ description: "A speech model id served by the Redrob gateway" }),
})

export const ControlPaths = {
  auth: "/auth/:providerID",
  log: "/log",
  speech: "/redrob/speech",
} as const

export const ControlApi = HttpApi.make("control").add(
  HttpApiGroup.make("control")
    .add(
      HttpApiEndpoint.put("authSet", ControlPaths.auth, {
        params: AuthParams,
        payload: Auth.Info,
        success: described(Schema.Boolean, "Successfully set authentication credentials"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "auth.set",
          summary: "Set auth credentials",
          description: "Set authentication credentials",
        }),
      ),
      HttpApiEndpoint.delete("authRemove", ControlPaths.auth, {
        params: AuthParams,
        success: described(Schema.Boolean, "Successfully removed authentication credentials"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "auth.remove",
          summary: "Remove auth credentials",
          description: "Remove authentication credentials",
        }),
      ),
      /*
       * Speech on the engine's own Redrob credential, for a client that has to play audio and must
       * not hold the key: Redrob Cowork's read-aloud. The key never leaves this process.
       */
      HttpApiEndpoint.post("speech", ControlPaths.speech, {
        payload: SpeechInput,
        success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "audio/mpeg" })),
        error: [InvalidRequestError, ServiceUnavailableError, UpstreamError, TimeoutError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "redrob.speech",
          summary: "Speak text",
          description: "Turn text into mp3 speech through the Redrob gateway, billed to the connected Redrob account.",
        }),
      ),
      HttpApiEndpoint.post("log", ControlPaths.log, {
        query: LogQuery,
        payload: LogInput,
        success: described(Schema.Boolean, "Log entry written successfully"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "app.log",
          summary: "Write log",
          description: "Write a log entry to the server logs with specified level and metadata.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "control", description: "Control plane routes." })),
)
