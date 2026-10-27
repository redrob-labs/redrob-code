export * as Routine from "./routine"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { NonNegativeInt, PositiveInt, optional, statics } from "./schema"
import { SessionID } from "./session-id"

const IDSchema = Schema.String.check(Schema.isStartsWith("rtn")).pipe(Schema.brand("RoutineID"))

export const ID = IDSchema.pipe(
  statics((schema: typeof IDSchema) => {
    const create = () => schema.make("rtn_" + ascending())
    return {
      create,
      ascending: (id?: string) => (id === undefined ? create() : schema.make(id)),
    }
  }),
)
export type ID = typeof ID.Type

/** Next turn as soon as the previous one ends. This is the autopilot. */
export const AfterTurn = Schema.Struct({ type: Schema.Literal("after_turn") }).annotate({
  identifier: "RoutineTriggerAfterTurn",
})

/** A cron expression or a fixed interval. Exactly one of `cron` and `every`. */
export const ScheduleTrigger = Schema.Struct({
  type: Schema.Literal("schedule"),
  cron: optional(Schema.String).annotate({ description: "5- or 6-field cron expression" }),
  every: optional(PositiveInt).annotate({ description: "Interval in seconds" }),
  timezone: optional(Schema.String).annotate({ description: "IANA time zone the cron expression is read in" }),
}).annotate({ identifier: "RoutineTriggerSchedule" })

/** Poll a subject and wake only when it changes. Only GitHub pull requests for now. */
export const WatchTrigger = Schema.Struct({
  type: Schema.Literal("watch"),
  kind: Schema.Literal("github_pr"),
  url: Schema.String.annotate({ description: "Full pull request URL" }),
  interval: optional(PositiveInt).annotate({ description: "Seconds between polls (default 300, min 60)" }),
}).annotate({ identifier: "RoutineTriggerWatch" })

export const Trigger = Schema.Union([AfterTurn, ScheduleTrigger, WatchTrigger]).annotate({
  discriminator: "type",
  identifier: "RoutineTrigger",
})
export type Trigger = typeof Trigger.Type

export const Status = Schema.Literals(["running", "paused", "done", "blocked", "stopped"]).annotate({
  identifier: "RoutineStatus",
})
export type Status = typeof Status.Type

export const Info = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  goal: Schema.String,
  trigger: Trigger,
  status: Status,
  cycles: NonNegativeInt,
  maxCycles: PositiveInt,
  rejected: Schema.Array(Schema.String).annotate({ description: "Approaches already tried and ruled out" }),
  reason: optional(Schema.String).annotate({ description: "Why the routine stopped or paused" }),
  time: Schema.Struct({ created: NonNegativeInt, updated: NonNegativeInt }),
}).annotate({ identifier: "Routine" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const CreateInput = Schema.Struct({
  sessionID: SessionID,
  goal: Schema.String,
  trigger: Trigger,
  maxCycles: optional(PositiveInt),
}).annotate({ identifier: "RoutineCreateInput" })
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}

const Updated = define({ type: "routine.updated", schema: { info: Info } })
export const Event = { Updated, Definitions: inventory(Updated) }
