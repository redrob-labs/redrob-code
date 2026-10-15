export * as BrowserRequest from "./browser-request"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { optional, statics } from "./schema"
import { SessionID } from "./session-id"

/**
 * PA-10: one browser action the engine wants performed, and the answer coming back.
 *
 * The engine process cannot reach a browser page. The direction that DOES exist is the
 * client subscribing to `GET /api/event`, so a browser action is modelled as a pending
 * request published on that stream and settled by an HTTP reply — the same shape
 * `QuestionV2` already uses for asking a person something.
 *
 * Nothing here opens a socket, and nothing here is a listener the engine owns. That is the
 * point: a loopback endpoint that can drive a browser is reachable by every other local
 * process, and a web page can reach it too (DNS rebinding, missing Host/Origin checks).
 * The client dials the engine, never the reverse.
 */
export const ID = Schema.String.check(Schema.isStartsWith("brq")).pipe(
  Schema.brand("BrowserRequest.ID"),
  statics((schema) => {
    const create = () => schema.make("brq_" + ascending())
    return {
      create,
      ascending: (id?: string) => (id === undefined ? create() : schema.make(id)),
    }
  }),
)
export type ID = typeof ID.Type

/** A node a page query returned. Mirrors `PageNode` in the engine's domain module. */
export const Node = Schema.Struct({
  selector: Schema.String,
  text: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.String),
}).annotate({ identifier: "BrowserRequest.Node" })
export interface Node extends Schema.Schema.Type<typeof Node> {}

const Url = Schema.Struct({ action: Schema.Literal("page.url") })
const Text = Schema.Struct({ action: Schema.Literal("page.text") })
const Query = Schema.Struct({
  action: Schema.Literal("page.query"),
  selector: Schema.String,
  limit: Schema.Number.pipe(optional),
})
const Click = Schema.Struct({ action: Schema.Literal("page.click"), selector: Schema.String })
const Type = Schema.Struct({
  action: Schema.Literal("page.type"),
  selector: Schema.String,
  text: Schema.String,
  submit: Schema.Boolean.pipe(optional),
})
const Navigate = Schema.Struct({ action: Schema.Literal("page.navigate"), url: Schema.String })

/**
 * What the client is being asked to do, discriminated by `action`.
 *
 * The action names are the `page` interface's method names with their object prefixed, so a
 * refusal, a log line and a skill's own source all name the same call.
 */
export const Command = Schema.Union([Url, Text, Query, Click, Type, Navigate])
  .pipe(Schema.toTaggedUnion("action"))
  .annotate({ identifier: "BrowserRequest.Command" })
export type Command = typeof Command.Type

/** The action names, for a client that wants to check it handles all of them. */
export const ACTIONS = ["page.url", "page.text", "page.query", "page.click", "page.type", "page.navigate"] as const
export type Action = (typeof ACTIONS)[number]

export const Request = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  command: Command,
}).annotate({ identifier: "BrowserRequest.Request" })
export interface Request extends Schema.Schema.Type<typeof Request> {}

/**
 * The value a settled request carries.
 *
 * Deliberately a tagged union rather than one permissive `unknown`: the engine knows which
 * shape each action must produce, so a client answering `page.query` with a string is a
 * protocol error the engine can name, not an empty node list the model reads as "nothing
 * matched". The two are different claims.
 */
const StringValue = Schema.Struct({ type: Schema.Literal("string"), value: Schema.String })
const NodesValue = Schema.Struct({ type: Schema.Literal("nodes"), value: Schema.Array(Node) })
const VoidValue = Schema.Struct({ type: Schema.Literal("void") })

export const Value = Schema.Union([StringValue, NodesValue, VoidValue])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "BrowserRequest.Value" })
export type Value = typeof Value.Type

export const Reply = Schema.Struct({
  value: Value,
}).annotate({ identifier: "BrowserRequest.Reply" })
export interface Reply extends Schema.Schema.Type<typeof Reply> {}

/**
 * Why the client could not do it: the tab is gone, the selector matched nothing, the user
 * has not exposed this tab. A refusal is a normal outcome, not an exception, so it travels
 * as its own route rather than as a missing reply that would stall until the deadline.
 */
export const Refusal = Schema.Struct({
  reason: Schema.String.annotate({ description: "Why the action could not be performed, in one sentence." }),
}).annotate({ identifier: "BrowserRequest.Refusal" })
export interface Refusal extends Schema.Schema.Type<typeof Refusal> {}

const Asked = define({ type: "browser.request.asked", schema: Request.fields })
const Answered = define({
  type: "browser.request.answered",
  schema: { sessionID: SessionID, requestID: ID },
})
const Refused = define({
  type: "browser.request.refused",
  schema: { sessionID: SessionID, requestID: ID, reason: Schema.String },
})

export const Event = { Asked, Answered, Refused, Definitions: inventory(Asked, Answered, Refused) }
