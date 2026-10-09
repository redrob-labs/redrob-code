export * as Insights from "./insights"

import { Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"

import { Insights as Wire } from "@redrob-code/schema/insights"

import { ConsoleKey } from "./console-key"
import { CONSOLE_URL } from "./plugin/provider/redrob-constants"

/**
 * Sends an app's labeled sessions to the console's insights, with the Redrob key this engine holds.
 *
 * The point is custody: the app hands over labels and gets back what the console did with them, and the
 * key never leaves the engine. So nothing here returns the key, logs it, or takes a destination from the
 * caller -- the batch goes to `${CONSOLE_URL}/insights/sessions` and nowhere else, `CONSOLE_URL` being the
 * one constant every console call in this engine uses (its developer override included).
 *
 * No retries: an app sends from a queue on its own schedule, and keeps a batch that got no answer for its
 * next run. A second retry loop here would only hide from the app that the console was unreachable.
 */

const REQUEST_TIMEOUT = "30 seconds"

export class NotConnected extends Error {
  readonly _tag = "InsightsNotConnected"
  constructor() {
    super("the Redrob provider is not connected, so there is no key to send insights with")
  }
}

export class Refused extends Error {
  readonly _tag = "InsightsRefused"
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * The console's error body, read for its message because that is what a person can act on. NestJS answers
 * a validation failure with `message` as a list of strings, so both spellings are read.
 */
const ErrorEnvelope = Schema.Struct({
  message: Schema.Union([Schema.String, Schema.Array(Schema.String)]).pipe(Schema.optional),
  error: Schema.Union([Schema.String, Schema.Struct({ message: Schema.String.pipe(Schema.optional) })]).pipe(
    Schema.optional,
  ),
})

function describe(status: number, body: string): string {
  const fallback = `the console refused the insights batch with ${status}`
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorEnvelope))(body)
  if (parsed._tag === "None") return fallback
  const { message, error } = parsed.value
  if (Array.isArray(message)) return message.join("; ") || fallback
  if (typeof message === "string" && message) return message
  if (typeof error === "object" && error?.message) return error.message
  return fallback
}

/** The call, with the HTTP client left to the caller so a test can stand in for the console. */
export const send = Effect.fn("Insights.send")(function* (request: Wire.SessionsRequest) {
  const apiKey = yield* ConsoleKey.resolve()
  if (!apiKey) return yield* Effect.fail(new NotConnected())

  const http = yield* HttpClient.HttpClient
  const outgoing = yield* HttpClientRequest.post(`${CONSOLE_URL}/insights/sessions`).pipe(
    HttpClientRequest.bearerToken(apiKey),
    HttpClientRequest.schemaBodyJson(Wire.SessionsRequest)(request),
  )
  const response = yield* http.execute(outgoing).pipe(Effect.timeout(REQUEST_TIMEOUT))
  const body = yield* response.text

  if (response.status < 200 || response.status >= 300) {
    return yield* Effect.fail(new Refused(response.status, describe(response.status, body)))
  }
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Wire.SessionsResult))(body)
  if (decoded._tag === "None")
    return yield* Effect.fail(new Refused(response.status, "could not read the console's answer"))
  return decoded.value
})

/*
  The fetch client is provided here, as in variants.ts, so the HTTP client requirement does not leak into
  the API's requirement type. One call per app sync, every few minutes, needs no shared pool.
*/
export const sessions = (request: Wire.SessionsRequest) => Effect.provide(send(request), FetchHttpClient.layer)
