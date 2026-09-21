import { Variants } from "@redrob-code/core/variants"
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
 * The multi-model routes, and the one place the console's refusals become this API's errors.
 *
 * Mapping by STATUS rather than passing the console's status through, because the two APIs answer different
 * questions. A 402 from the console means that workspace's key is over its budget -- to a caller of this
 * server that is an authorization problem with the upstream account, not a payment this server is asking
 * for. Forwarding 402 would invite a client to show a checkout it cannot complete.
 *
 * The console's MESSAGE is always carried through, because it is the part a person can act on: "This API
 * key has spent $25.00 of its $25.00 monthly budget" says what to do and a bare status does not.
 */

/** Why no key means 404 rather than 401: there is nothing configured to ask, so nothing refused us. */
const notConnected = () =>
  new ProviderNotFoundError({
    providerID: "redrob",
    message:
      "The Redrob provider is not connected, so the multi-model endpoints are unavailable. Connect it with `redrob providers login`.",
  })

function refusal(error: Variants.Refused) {
  const status = error.status
  if (status === 401 || status === 403) {
    return new UnauthorizedError({ message: error.message })
  }
  if (status === 402) {
    /*
      Out of credit, or a key over its monthly budget. Surfaced as unauthorized rather than as a payment
      this server wants: the money is owed to the console by the account behind the key, and the caller of
      this route may not be the person who can settle it.
    */
    return new UnauthorizedError({ message: error.message })
  }
  if (status === 429) {
    /*
      Rate limited. `ServiceUnavailableError` because the remedy is to wait, and the message already says
      how long -- the console puts the figure in the sentence as well as in `Retry-After`.
    */
    return new ServiceUnavailableError({ message: error.message })
  }
  if (status >= 400 && status < 500) {
    return new InvalidRequestError({ message: error.message })
  }
  return new ServiceUnavailableError({ message: error.message })
}

/*
  Generic over BOTH the error and requirement channels, because the service can fail in more ways than its
  own two: the HTTP client contributes transport failures and the timeout contributes its own. Pinning those
  away claimed they could not happen, and the type checker caught it -- which matters, because an unhandled
  transport failure would have surfaced as an unmapped 500 with no message for the caller.
*/
/** The union this route declares. Named so the catch below cannot be narrowed to its first branch. */
type RouteError =
  | InvalidRequestError
  | UnauthorizedError
  | ProviderNotFoundError
  | ServiceUnavailableError

const handle = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, RouteError, R> =>
  effect.pipe(
    Effect.catch((error): Effect.Effect<never, RouteError> => {
      if (error instanceof Variants.Refused) return Effect.fail(refusal(error))
      if (error instanceof Variants.NotConnected) return Effect.fail(notConnected())
      /*
        Timeout, DNS failure, connection refused, a body that would not encode. All of them mean the console
        could not be reached or answered, which is the caller's cue to try again rather than to change the
        request -- so they are service-unavailable, and the underlying message is carried so the reason is
        not lost.
      */
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

export const VariantHandler = HttpApiBuilder.group(Api, "server.variant", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "variant.paraphrase",
        Effect.fn(function* (ctx) {
          return yield* handle(Variants.paraphrase(ctx.payload))
        }),
      )
      .handle(
        "variant.compare",
        Effect.fn(function* (ctx) {
          return yield* handle(Variants.compare(ctx.payload))
        }),
      )
  }),
)
