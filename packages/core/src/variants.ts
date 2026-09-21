export * as Variants from "./variants"

import { Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"

import { Variant } from "@redrob-code/schema/variant"

import { ConsoleKey } from "./console-key"
import { CONSOLE_URL } from "./plugin/provider/redrob-constants"

/**
 * The console's multi-model endpoints, reached once on behalf of every client.
 *
 * `/v1/variants/paraphrase` and `/v1/variants/compare` are not OpenAI-standard, so they cannot arrive
 * through the `@ai-sdk/openai-compatible` path. Putting them here rather than in each caller keeps one
 * place that knows how to find the credential, what the console's envelope looks like, and how its
 * refusals map -- three things that would otherwise drift between the CLI and the desktop apps.
 *
 * WHAT IS DELIBERATELY PASSED THROUGH RATHER THAN SUMMARISED: the per-slot `redrob` block, carrying
 * `routedModel` and `costUsd`. When a request names `auto`, `routedModel` is the only thing that says which
 * model actually answered, and one request here makes several charges -- so a caller that wants to show a
 * user what was used and what it cost needs both, per slot, not a total.
 */

/** No retries and no long wait: these are user-initiated and a caller can ask again. */
const REQUEST_TIMEOUT = "120 seconds"

export class NotConnected extends Error {
  readonly _tag = "VariantsNotConnected"
  constructor() {
    super("the Redrob provider is not connected, so the console's multi-model endpoints are unavailable")
  }
}

export class Refused extends Error {
  readonly _tag = "VariantsRefused"
  constructor(
    readonly status: number,
    message: string,
    /** Seconds the console asked the caller to wait, when it said. Surfaced so a UI can say when to retry. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
  }
}

/**
 * The console's own error envelope.
 *
 * Read rather than ignored because the message is the useful part: "This API key has spent $25.00 of its
 * $25.00 monthly budget" tells a user what to do, and the status alone does not. A body that does not parse
 * falls back to the status, which is still better than nothing.
 */
const ErrorEnvelope = Schema.Struct({
  message: Schema.String.pipe(Schema.optional),
  error: Schema.Struct({ message: Schema.String.pipe(Schema.optional) }).pipe(Schema.optional),
  retryAfterSeconds: Schema.Finite.pipe(Schema.optional),
})

function describe(status: number, body: string): { message: string; retryAfterSeconds?: number } {
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorEnvelope))(body)
  if (parsed._tag === "None") return { message: `the console refused the request with ${status}` }
  const value = parsed.value
  return {
    message:
      value.error?.message ?? value.message ?? `the console refused the request with ${status}`,
    retryAfterSeconds: value.retryAfterSeconds,
  }
}

const call = Effect.fn("Variants.call")(function* <A>(
  path: string,
  schema: Schema.Codec<A, unknown>,
  payload: A,
) {
  const apiKey = yield* ConsoleKey.resolve()
  /*
    No key means the provider is not connected, which is a different thing from a rejected key: there is
    nothing to ask. Callers turn this into a 404 rather than a 401, so a user on a local runtime is told the
    feature is not available instead of being sent to check a credential they never set.
  */
  if (!apiKey) return yield* Effect.fail(new NotConnected())

  const http = yield* HttpClient.HttpClient
  /*
    Encoded THROUGH THE SCHEMA rather than handed to a generic JSON body: the request shape is declared once
    and this is what holds the wire format to it, so a field renamed in the schema cannot silently keep
    sending the old name.
  */
  /*
    `CONSOLE_URL` already carries the developer override and is already trailing-slash trimmed. Resolving
    the flag a second time here is what let the override apply to this service alone while the session's
    inference path kept talking to production.
  */
  const request = yield* HttpClientRequest.post(`${CONSOLE_URL}${path}`).pipe(
    HttpClientRequest.bearerToken(apiKey),
    HttpClientRequest.schemaBodyJson(schema)(payload),
  )

  const response = yield* http.execute(request).pipe(Effect.timeout(REQUEST_TIMEOUT))
  const body = yield* response.text

  if (response.status < 200 || response.status >= 300) {
    const { message, retryAfterSeconds } = describe(response.status, body)
    /*
      `Retry-After` is preferred over the body figure when both are present: it is the header HTTP clients
      are built around, and the console sets it on exactly the statuses where waiting is the remedy.
    */
    const header = response.headers["retry-after"]
    const fromHeader = typeof header === "string" ? Number(header) : Number.NaN
    return yield* Effect.fail(
      new Refused(
        response.status,
        message,
        Number.isFinite(fromHeader) ? fromHeader : retryAfterSeconds,
      ),
    )
  }

  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Variant.Result))(body)
  if (decoded._tag === "None") {
    return yield* Effect.fail(new Refused(response.status, "could not read the console's response"))
  }
  return decoded.value
})

/*
  The HTTP client is provided HERE rather than demanded from callers.

  Without this the `HttpClient` requirement propagated out of these two functions, through the route
  handler, into the API's own requirement type, and out to every entry point that builds the API -- the
  `serve` command failed to typecheck with `Type 'HttpClient' is not assignable to type 'Service'`, which
  reads as a problem with `serve` and is not one. A leaf that makes one outbound call should not widen the
  contract of everything above it.

  The repository's usual shape for this is a service node with `deps: () => [..., httpClient]`, which
  shares one client process-wide. These are two plain functions rather than a service, so they take their
  own fetch client instead. That is a real difference -- no shared connection pooling with the rest of the
  CLI -- and it is proportionate for two endpoints called only on an explicit user action. Turning this
  into a service node is the right move if it ever grows a third caller.
*/
const withHttp = <A, E, R>(effect: Effect.Effect<A, E, R | HttpClient.HttpClient>) =>
  Effect.provide(effect, FetchHttpClient.layer)

export const paraphrase = (request: Variant.ParaphraseRequest) =>
  withHttp(call("/variants/paraphrase", Variant.ParaphraseRequest, request))

export const compare = (request: Variant.CompareRequest) =>
  withHttp(call("/variants/compare", Variant.CompareRequest, request))
