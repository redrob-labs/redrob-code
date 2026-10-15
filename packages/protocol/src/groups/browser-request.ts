import { BrowserRequest } from "@redrob-code/schema/browser-request"
import { Location } from "@redrob-code/schema/location"
import { Session } from "@redrob-code/schema/session"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { BrowserRequestNotFoundError, SessionNotFoundError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

/**
 * PA-10: the client half of the browser channel.
 *
 * Three routes and no listener. The client already holds the engine's event stream, so it
 * learns about a request there and settles it here — `reply` with a value, `refuse` with a
 * sentence. The engine never connects to the browser, which is the property that keeps a
 * local page or another local process from driving it.
 */
export const makeBrowserRequestGroup = <
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(
  locationMiddleware: Context.Key<LocationId, LocationService>,
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
) =>
  HttpApiGroup.make("server.browser")
    .add(
      HttpApiEndpoint.get("browser.request.list", "/api/browser/request", {
        query: LocationQuery,
        success: Location.response(Schema.Array(BrowserRequest.Request)),
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v1.browser.request.list",
            summary: "List pending browser requests",
            description:
              "Retrieve browser actions awaiting a client for a location. A client that reconnects uses this to recover requests published while it was away.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({ title: "browser requests", description: "Browser actions awaiting a client." }),
    )
    // Group middleware applies only to endpoints already added; the session endpoints below
    // carry session placement instead.
    .middleware(locationMiddleware)
    .add(
      HttpApiEndpoint.get("session.browser.list", "/api/session/:sessionID/browser", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(BrowserRequest.Request) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v1.session.browser.list",
            summary: "List session browser requests",
            description: "Retrieve browser actions awaiting a client, owned by a session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.browser.reply", "/api/session/:sessionID/browser/:requestID/reply", {
        params: { sessionID: Session.ID, requestID: BrowserRequest.ID },
        payload: BrowserRequest.Reply,
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, BrowserRequestNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v1.session.browser.reply",
            summary: "Answer a pending browser request",
            description:
              "Settle a browser action with the value it produced. The value is typed per action, so answering with the wrong shape is reported to the engine's caller rather than read as a fact about the page.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.browser.refuse", "/api/session/:sessionID/browser/:requestID/refuse", {
        params: { sessionID: Session.ID, requestID: BrowserRequest.ID },
        payload: BrowserRequest.Refusal,
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, BrowserRequestNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v1.session.browser.refuse",
            summary: "Refuse a pending browser request",
            description:
              "Report that the action could not be performed, with the reason. Refusing is faster and more honest than letting the request expire on the engine's deadline.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "session browser requests",
        description: "Session-owned browser action routes.",
      }),
    )
