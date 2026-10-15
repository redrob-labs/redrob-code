import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

/**
 * The privacy switch. One value for the whole engine, so an app shows a toggle and nothing more:
 * `off` (default), `regex` (emails, phones, cards, resident numbers), `model` (regex plus a local
 * model naming people, organisations and places).
 */
export const PrivacySettings = Schema.Struct({
  mode: Schema.Literals(["off", "regex", "model"]),
  model: Schema.optional(Schema.String).annotate({
    description: "For mode = model: the LOCAL model that finds names, as provider/model",
  }),
}).annotate({ identifier: "PrivacySettings" })

export const PrivacyGroup = HttpApiGroup.make("server.privacy")
  .add(
    HttpApiEndpoint.get("privacy.get", "/api/privacy", {
      query: LocationQuery,
      success: PrivacySettings,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.privacy.get",
          summary: "Read the PII masking setting",
          description: "What personal data may leave this machine inside a model request.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.put("privacy.set", "/api/privacy", {
      query: LocationQuery,
      payload: PrivacySettings,
      success: PrivacySettings,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.privacy.set",
          summary: "Change the PII masking setting",
          description:
            "Takes effect on the next message and is written to the user's global redrob.json, so it holds across restarts and apps.",
        }),
      ),
  )
