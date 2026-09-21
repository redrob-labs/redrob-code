import { Variant } from "@redrob-code/schema/variant"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import {
  InvalidRequestError,
  ProviderNotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "../errors"

/**
 * Asking several models the same thing.
 *
 * Exposed here rather than reached directly by each client, so the credential resolution, retries and
 * error mapping exist once. The CLI's commands, the desktop apps, and anything else on the SDK all get the
 * same behaviour, and the endpoints stay usable by a client that has no idea the console exists.
 *
 * `ProviderNotFoundError` is the refusal when the Redrob provider is not connected. That is a 404 about a
 * provider rather than a 400 about the request, because the request was fine -- there is simply nothing
 * here to serve it. A user on a local runtime or another vendor learns that immediately instead of seeing a
 * credential error from a call that could never have worked.
 */
export const VariantGroup = HttpApiGroup.make("server.variant")
  .add(
    HttpApiEndpoint.post("variant.paraphrase", "/api/variant/paraphrase", {
      payload: Variant.ParaphraseRequest,
      success: Variant.Result,
      error: [InvalidRequestError, UnauthorizedError, ProviderNotFoundError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.variant.paraphrase",
        summary: "Rewrite one text with several models",
        description:
          "Send the same text to two or more models and get each rewrite back, with the model that actually answered and what that slot cost.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("variant.compare", "/api/variant/compare", {
      payload: Variant.CompareRequest,
      success: Variant.Result,
      error: [InvalidRequestError, UnauthorizedError, ProviderNotFoundError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.variant.compare",
        summary: "Answer one conversation with several models",
        description:
          "Send the same messages to two or more models and get each answer back, so a caller can offer them as a choice.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "variants",
      description: "Experimental multi-model routes. Available while the Redrob provider is connected.",
    }),
  )
