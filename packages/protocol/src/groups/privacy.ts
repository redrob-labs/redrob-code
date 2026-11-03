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

/** Most texts one mask call takes, and the longest each may be. */
export const MASK_MAX_TEXTS = 50
export const MASK_MAX_TEXT_LENGTH = 100_000

export const PrivacyMaskRequest = Schema.Struct({
  texts: Schema.Array(Schema.String.check(Schema.isMaxLength(MASK_MAX_TEXT_LENGTH))).check(
    Schema.isLengthBetween(1, MASK_MAX_TEXTS),
  ),
}).annotate({ identifier: "PrivacyMaskRequest" })

export const PrivacyMaskEntity = Schema.Struct({
  placeholder: Schema.String,
  value: Schema.String,
  kind: Schema.Literals(["EMAIL", "PHONE", "CARD", "RRN", "PERSON", "ORG", "LOC"]),
}).annotate({ identifier: "PrivacyMaskEntity" })

export const PrivacyMaskResult = Schema.Struct({
  mode: Schema.Literals(["regex", "model"]).annotate({
    description: "model only when the local model answered; regex when none is set, it failed or timed out",
  }),
  model: Schema.NullOr(Schema.String),
  texts: Schema.Array(Schema.String),
  entities: Schema.Array(PrivacyMaskEntity),
}).annotate({ identifier: "PrivacyMaskResult" })

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
  .add(
    HttpApiEndpoint.post("privacy.mask", "/api/privacy/mask", {
      query: LocationQuery,
      payload: PrivacyMaskRequest,
      success: PrivacyMaskResult,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.privacy.mask",
          summary: "Mask personal data in texts",
          description:
            "Masks the texts on this machine: always the regex tier, plus the configured local model (privacy.model) whatever the mode switch says, because the caller asked. One vault per call. The model call times out after 15 s and falls back to regex.",
        }),
      ),
  )
