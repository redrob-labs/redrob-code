import { BrowserRequestV1 } from "@redrob-code/core/browser-request"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { BrowserRequestNotFoundError } from "@redrob-code/protocol/errors"
import { response } from "../location"

/**
 * PA-10 server half. Mirrors the question handler, including its ownership check: a reply
 * is accepted only for a request that belongs to the session in the path, so one session's
 * client cannot settle another's pending browser action.
 */
function missingRequest(id: BrowserRequestV1.ID) {
  return new BrowserRequestNotFoundError({
    requestID: id,
    // Says the likely cause, because the expired case is normal rather than a client bug.
    message: `Browser request not found: ${id}. It was answered already, or it expired on the engine's deadline.`,
  })
}

export const BrowserRequestHandler = HttpApiBuilder.group(Api, "server.browser", (handlers) =>
  Effect.gen(function* () {
    const withOwnedRequest = Effect.fnUntraced(function* <A, E>(
      sessionID: BrowserRequestV1.Request["sessionID"],
      requestID: BrowserRequestV1.ID,
      use: (browser: BrowserRequestV1.Interface) => Effect.Effect<A, E>,
    ) {
      const browser = yield* BrowserRequestV1.Service
      const request = (yield* browser.list()).find((request) => request.id === requestID)
      if (!request || request.sessionID !== sessionID) return yield* missingRequest(requestID)
      return yield* use(browser)
    })

    return handlers
      .handle(
        "browser.request.list",
        Effect.fn(function* () {
          return yield* response((yield* BrowserRequestV1.Service).list())
        }),
      )
      .handle(
        "session.browser.list",
        Effect.fn(function* (ctx) {
          const requests = yield* (yield* BrowserRequestV1.Service).list()
          return { data: requests.filter((request) => request.sessionID === ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.browser.reply",
        Effect.fn(function* (ctx) {
          yield* withOwnedRequest(ctx.params.sessionID, ctx.params.requestID, (browser) =>
            browser
              .reply({ requestID: ctx.params.requestID, value: ctx.payload.value })
              .pipe(Effect.catchTag("BrowserRequestV1.NotFoundError", () => missingRequest(ctx.params.requestID))),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.browser.refuse",
        Effect.fn(function* (ctx) {
          yield* withOwnedRequest(ctx.params.sessionID, ctx.params.requestID, (browser) =>
            browser
              .refuse({ requestID: ctx.params.requestID, reason: ctx.payload.reason })
              .pipe(Effect.catchTag("BrowserRequestV1.NotFoundError", () => missingRequest(ctx.params.requestID))),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
