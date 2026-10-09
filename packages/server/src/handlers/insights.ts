import { Insights } from "@redrob-code/core/insights"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"

import { Api } from "../api"
import {
  InvalidRequestError,
  ProviderNotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "@redrob-code/protocol/errors"

/**
 * The insights route, and where the console's refusals become this API's errors, by the same rules as
 * the variants routes (handlers/variant.ts): an over-budget or rejected key is unauthorized, a refused
 * batch is an invalid request, and anything that means "try again later" is service-unavailable. The
 * console's message is carried through, because it is what says which field it refused.
 */

const notConnected = () =>
  new ProviderNotFoundError({
    providerID: "redrob",
    message: "The Redrob provider is not connected, so there is no key to send insights with.",
  })

function refusal(error: Insights.Refused) {
  const status = error.status
  if (status === 401 || status === 402 || status === 403) return new UnauthorizedError({ message: error.message })
  if (status === 429) return new ServiceUnavailableError({ message: error.message })
  if (status >= 400 && status < 500) return new InvalidRequestError({ message: error.message })
  return new ServiceUnavailableError({ message: error.message })
}

type RouteError = InvalidRequestError | UnauthorizedError | ProviderNotFoundError | ServiceUnavailableError

const handle = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, RouteError, R> =>
  effect.pipe(
    Effect.catch((error): Effect.Effect<never, RouteError> => {
      if (error instanceof Insights.Refused) return Effect.fail(refusal(error))
      if (error instanceof Insights.NotConnected) return Effect.fail(notConnected())
      return Effect.fail(
        new ServiceUnavailableError({
          message:
            error instanceof Error
              ? `could not reach the Redrob console: ${error.message}`
              : "could not reach the Redrob console",
        }),
      )
    }),
  )

export const InsightsHandler = HttpApiBuilder.group(Api, "server.insights", (handlers) =>
  Effect.gen(function* () {
    return handlers.handle(
      "insights.sessions",
      Effect.fn(function* (ctx) {
        return yield* handle(Insights.sessions(ctx.payload))
      }),
    )
  }),
)
