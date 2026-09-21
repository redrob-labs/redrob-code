export * as SessionStatusEvent from "./session-status-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { NonNegativeInt } from "./schema"
import { SessionID } from "./session-id"

export const Info = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("idle"),
  }),
  Schema.Struct({
    type: Schema.Literal("retry"),
    attempt: NonNegativeInt,
    message: Schema.String,
    action: optional(
      Schema.Struct({
        reason: Schema.String,
        provider: Schema.String,
        title: Schema.String,
        message: Schema.String,
        label: Schema.String,
        link: optional(Schema.String),
      }),
    ),
    next: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("busy"),
  }),
  /**
   * The turn stopped and no retry will fix it, but there IS something the user can do.
   *
   * Distinct from `retry` because that variant means a retry is in flight: a client renders it with a
   * spinner and a countdown, which would be a lie here. Distinct from a plain session error because
   * those travel as message text and so can carry no link -- the user was told "budget exhausted" and
   * left to find the page themselves.
   *
   * The console's 402s are the case this exists for. Both a key over its monthly cap and an account with
   * an empty balance are refusals a person fixes in the console, and the console deliberately answers 402
   * rather than 429 so that clients STOP instead of turning one refusal into six.
   */
  Schema.Struct({
    type: Schema.Literal("blocked"),
    message: Schema.String,
    action: optional(
      Schema.Struct({
        reason: Schema.String,
        provider: Schema.String,
        title: Schema.String,
        message: Schema.String,
        label: Schema.String,
        link: optional(Schema.String),
      }),
    ),
  }),
]).annotate({ identifier: "SessionStatus" })
export type Info = Schema.Schema.Type<typeof Info>

export const Status = Event.define({
  type: "session.status",
  schema: {
    sessionID: SessionID,
    status: Info,
  },
})

// deprecated
export const Idle = Event.define({
  type: "session.idle",
  schema: {
    sessionID: SessionID,
  },
})

export const Definitions = Event.inventory(Status, Idle)
