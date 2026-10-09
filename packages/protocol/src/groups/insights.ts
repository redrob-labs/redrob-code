import { Insights } from "@redrob-code/schema/insights"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import {
  InvalidRequestError,
  ProviderNotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "../errors"

/**
 * Sending labeled AI work sessions to the Redrob console's insights.
 *
 * For an app that holds no credential of its own: it hands the engine the labels, the engine posts them
 * with the Redrob key it holds, and the app gets back what the console did with them. The key is never
 * returned and the destination is fixed, so this route cannot be used to read the key or to send it
 * anywhere but the console.
 *
 * `ProviderNotFoundError` when the Redrob provider is not connected, as for the variants routes: the
 * request was fine, there is just no key here to send it with.
 */
export const InsightsGroup = HttpApiGroup.make("server.insights")
  .add(
    HttpApiEndpoint.post("insights.sessions", "/api/insights/sessions", {
      payload: Insights.SessionsRequest,
      success: Insights.SessionsResult,
      error: [InvalidRequestError, UnauthorizedError, ProviderNotFoundError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.insights.sessions",
        summary: "Send labeled sessions to the console",
        description:
          "Post up to 500 labeled AI work sessions to the Redrob console's insights with the Redrob key this engine holds, and get back how many were accepted, updated and rejected.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "insights",
      description: "Labeled AI work sessions for the Redrob console. Available while the Redrob provider is connected.",
    }),
  )
