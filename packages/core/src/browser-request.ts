export * as BrowserRequestV1 from "./browser-request"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Duration, Effect, Layer, Schema } from "effect"
import { BrowserRequest } from "@redrob-code/schema/browser-request"
import { EventV2 } from "./event"
import { SessionSchema } from "./session/schema"

export const ID = BrowserRequest.ID
export type ID = typeof ID.Type

export const Command = BrowserRequest.Command
export type Command = typeof Command.Type

export const Request = BrowserRequest.Request
export type Request = typeof Request.Type

export const Value = BrowserRequest.Value
export type Value = typeof Value.Type

export const Node = BrowserRequest.Node
export type Node = typeof Node.Type

export const Event = BrowserRequest.Event

/**
 * The deadline a pending browser request waits for a client before giving up.
 *
 * It exists because nothing tells the engine whether a client is listening: the event
 * stream is a publish/subscribe fan-out with no subscriber count, so "no browser attached"
 * and "the browser is thinking" look identical from here. Waiting forever is the one
 * behaviour that is certainly wrong — a skill calling `page.text()` with no browser would
 * hang its session rather than fail.
 *
 * Long enough that a real click and its navigation settle; short enough that an unattended
 * engine answers in seconds.
 */
export const DEADLINE = Duration.seconds(20)

/**
 * No client settled the request. Carries the action by name, because which call went
 * unanswered is the whole diagnostic: `page.navigate` timing out on a slow site and
 * `page.url` timing out with nothing attached are different problems.
 */
export class UnansweredError extends Schema.TaggedErrorClass<UnansweredError>()("BrowserRequestV1.UnansweredError", {
  action: Schema.String,
}) {
  override get message() {
    return `no browser client answered ${this.action} within ${Duration.toSeconds(DEADLINE)}s; the browser must be running with the Redrob extension attached to this engine`
  }
}

/** The client took the request and said it could not do it. Its sentence is carried through. */
export class RefusedError extends Schema.TaggedErrorClass<RefusedError>()("BrowserRequestV1.RefusedError", {
  action: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `the browser refused ${this.action}: ${this.reason}`
  }
}

/**
 * The client answered with a value the action cannot produce.
 *
 * Separate from `RefusedError` on purpose. A refusal is the browser reporting about the
 * page; this is the client disagreeing with the protocol, and collapsing the two would let
 * a wrong-shaped answer read as a fact about the page.
 */
export class MalformedError extends Schema.TaggedErrorClass<MalformedError>()("BrowserRequestV1.MalformedError", {
  action: Schema.String,
  expected: Schema.String,
  received: Schema.String,
}) {
  override get message() {
    return `the browser answered ${this.action} with a ${this.received} value where ${this.expected} was required`
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("BrowserRequestV1.NotFoundError", {
  requestID: ID,
}) {}

export type AskError = UnansweredError | RefusedError

export interface AskInput {
  readonly sessionID: SessionSchema.ID
  readonly command: Command
}

export interface ReplyInput {
  readonly requestID: ID
  readonly value: Value
}

export interface RefuseInput {
  readonly requestID: ID
  readonly reason: string
}

export interface Interface {
  /** Publishes one browser action and waits for a client to settle it. */
  readonly ask: (input: AskInput) => Effect.Effect<Value, AskError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError>
  readonly refuse: (input: RefuseInput) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@redrob/v1/BrowserRequest") {}

interface Pending {
  readonly request: Request
  readonly deferred: Deferred.Deferred<Value, RefusedError>
}

/**
 * Location-owned pending browser requests, materialized once per embedded Location so a
 * reply cannot settle another Location's request — the same ownership rule `QuestionV2`
 * documents and for the same reason.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const pending = new Map<ID, Pending>()

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        pending.values(),
        (item) =>
          Deferred.fail(
            item.deferred,
            new RefusedError({ action: item.request.command.action, reason: "the engine shut down" }),
          ),
        { discard: true },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    const ask = Effect.fn("BrowserRequestV1.ask")((input: AskInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const id = ID.ascending()
          const deferred = yield* Deferred.make<Value, RefusedError>()
          const request: Request = { id, sessionID: input.sessionID, command: input.command }
          pending.set(id, { request, deferred })
          return yield* events.publish(Event.Asked, request).pipe(
            Effect.andThen(
              restore(Deferred.await(deferred)).pipe(
                // `timeoutOrElse` with a failing fallback rather than a plain `timeout`:
                // the caller needs to be told that nobody answered, by action name, not
                // handed a generic timeout exception or an empty success.
                Effect.timeoutOrElse({
                  duration: DEADLINE,
                  orElse: () => Effect.fail(new UnansweredError({ action: input.command.action })),
                }),
              ),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                pending.delete(id)
              }),
            ),
          )
        }),
      ),
    )

    const reply = Effect.fn("BrowserRequestV1.reply")((input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          yield* events.publish(Event.Answered, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
          })
          yield* Deferred.succeed(existing.deferred, input.value)
          pending.delete(input.requestID)
        }),
      ),
    )

    const refuse = Effect.fn("BrowserRequestV1.refuse")((input: RefuseInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          yield* events.publish(Event.Refused, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            reason: input.reason,
          })
          yield* Deferred.fail(
            existing.deferred,
            new RefusedError({ action: existing.request.command.action, reason: input.reason }),
          )
          pending.delete(input.requestID)
        }),
      ),
    )

    const list = Effect.fn("BrowserRequestV1.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    return Service.of({ ask, reply, refuse, list })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: () => [EventV2.node] })
