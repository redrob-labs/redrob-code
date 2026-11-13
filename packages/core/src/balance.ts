export * as Balance from "./balance"

import { Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"

/**
 * The workspace's balance and spend, read from the console for `/status`.
 *
 * `GET <console>/usage/summary?tz=<IANA zone>` with the same workspace API key the Redrob provider
 * already sends for inference. The figures are the workspace's, across every device and app, which is
 * what the local session totals cannot say.
 *
 * Every failure is quiet: no key, a refused key (401), a bad zone (400), the rate limit (429), a console
 * that does not have the route yet (404), a timeout or a body that does not parse all return
 * `undefined`, and the caller shows the billing link it showed before. Nothing here logs, and the key
 * never leaves the request header.
 */

/** `/status` waits for this, so it stays short: a slow console must not hold the dialog. */
const TIMEOUT = "5 seconds"

const Period = Schema.Struct({
  since: Schema.String,
  spend: Schema.Finite,
  requestCount: Schema.Finite,
}).annotate({ identifier: "ConsoleUsagePeriod" })

export const Summary = Schema.Struct({
  currency: Schema.String,
  balance: Schema.Finite,
  complimentary: Schema.Boolean,
  plan: Schema.optional(Schema.String),
  tz: Schema.String,
  today: Period,
  month: Period,
}).annotate({ identifier: "ConsoleUsageSummary" })
export type Summary = Schema.Schema.Type<typeof Summary>

export type Input = {
  /** The console API base, `CONSOLE_URL` or the provider's configured `baseURL`. */
  url: string
  key: string
  tz: string
}

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Summary))

const read = Effect.fn("Balance.read")(function* (input: Input) {
  const http = yield* HttpClient.HttpClient
  const url = `${input.url.replace(/\/+$/, "")}/usage/summary?${new URLSearchParams({ tz: input.tz })}`
  const response = yield* http.execute(
    HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bearerToken(input.key)),
  )
  if (response.status !== 200) return undefined
  const parsed = decode(yield* response.text)
  return parsed._tag === "Some" ? parsed.value : undefined
})

export const summary = (input: Input): Effect.Effect<Summary | undefined> =>
  read(input).pipe(
    Effect.timeout(TIMEOUT),
    Effect.provide(FetchHttpClient.layer),
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
