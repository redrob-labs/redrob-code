import { InstanceState } from "@/effect/instance-state"
import { Routine } from "@/routine/store"
import type { SessionID } from "@/session/schema"
import { Routine as RoutineSchema } from "@redrob-code/schema/routine"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError, RoutineNotFoundError } from "../errors"

const notFound = (error: Routine.NotFoundError) =>
  Effect.fail(new RoutineNotFoundError({ routineID: error.id, message: error.message }))

const invalid = (error: Routine.InvalidError) => Effect.fail(new InvalidRequestError({ message: error.message }))

export const routineHandlers = HttpApiBuilder.group(InstanceHttpApi, "routine", (handlers) =>
  Effect.gen(function* () {
    const routines = yield* Routine.Service

    const list = Effect.fn("RoutineHttpApi.list")(function* (ctx: { query: { sessionID?: SessionID } }) {
      return yield* routines.list({ sessionID: ctx.query.sessionID })
    })

    const create = Effect.fn("RoutineHttpApi.create")(function* (ctx: { payload: RoutineSchema.CreateInput }) {
      const directory = yield* InstanceState.directory
      return yield* routines
        .create({ ...ctx.payload, directory })
        .pipe(Effect.catchTag("Routine.InvalidError", invalid))
    })

    const get = Effect.fn("RoutineHttpApi.get")(function* (ctx: { params: { routineID: Routine.ID } }) {
      return yield* routines.get(ctx.params.routineID).pipe(Effect.catchTag("Routine.NotFoundError", notFound))
    })

    const stop = Effect.fn("RoutineHttpApi.stop")(function* (ctx: { params: { routineID: Routine.ID } }) {
      return yield* routines
        .stop(ctx.params.routineID, "Stopped by the user.")
        .pipe(Effect.catchTag("Routine.NotFoundError", notFound))
    })

    const pause = Effect.fn("RoutineHttpApi.pause")(function* (ctx: { params: { routineID: Routine.ID } }) {
      return yield* routines
        .pause(ctx.params.routineID)
        .pipe(Effect.catchTag("Routine.NotFoundError", notFound), Effect.catchTag("Routine.InvalidError", invalid))
    })

    const resume = Effect.fn("RoutineHttpApi.resume")(function* (ctx: { params: { routineID: Routine.ID } }) {
      return yield* routines
        .resume(ctx.params.routineID)
        .pipe(Effect.catchTag("Routine.NotFoundError", notFound), Effect.catchTag("Routine.InvalidError", invalid))
    })

    return handlers
      .handle("list", list)
      .handle("create", create)
      .handle("get", get)
      .handle("stop", stop)
      .handle("pause", pause)
      .handle("resume", resume)
  }),
)
