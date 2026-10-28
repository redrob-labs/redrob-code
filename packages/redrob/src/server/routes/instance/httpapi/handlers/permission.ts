import { PermissionV1 } from "@redrob-code/core/v1/permission"
import { EventV2 } from "@redrob-code/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { PermissionNotFoundError } from "../errors"
import { RunnerAskPayload, RunnerAskResult } from "../groups/permission"

export const permissionHandlers = HttpApiBuilder.group(InstanceHttpApi, "permission", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Permission.Service
    const session = yield* Session.Service
    const events = yield* EventV2Bridge.Service

    const list = Effect.fn("PermissionHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const reply = Effect.fn("PermissionHttpApi.reply")(function* (ctx: {
      params: { requestID: PermissionV1.ID }
      payload: PermissionV1.ReplyBody
    }) {
      yield* svc
        .reply({
          requestID: ctx.params.requestID,
          reply: ctx.payload.reply,
          message: ctx.payload.message,
        })
        .pipe(
          Effect.catchTag("Permission.NotFoundError", (error) =>
            Effect.fail(
              new PermissionNotFoundError({
                requestID: String(error.requestID),
                message: `Permission request not found: ${error.requestID}`,
              }),
            ),
          ),
        )
      return true
    })

    /*
     * Raises the same `permission.asked` a local tool would, for a runner that ran the tool itself, and
     * blocks until the person answers. The session's own rules and earlier "always" answers apply, so a
     * pattern the person already allowed comes back "always" without a card. A request the runner
     * drops (its HTTP call closes) is interrupted here, which removes it from the pending list.
     */
    const ask = Effect.fn("PermissionHttpApi.ask")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RunnerAskPayload.Type
    }) {
      const info = yield* session.get(ctx.params.sessionID).pipe(Effect.orElseSucceed(() => undefined))
      const id = PermissionV1.ID.ascending()
      let answered: PermissionV1.Reply | undefined
      const unsubscribe = yield* events.listen((event) => {
        if (event.type !== Permission.Event.Replied.type) return Effect.void
        const data = event.data as EventV2.Data<typeof Permission.Event.Replied>
        if (data.requestID === id) answered = data.reply
        return Effect.void
      })
      return yield* svc
        .ask({
          id,
          sessionID: ctx.params.sessionID,
          permission: ctx.payload.permission,
          patterns: [...ctx.payload.patterns],
          metadata: { ...ctx.payload.metadata, runner: true },
          always: [...(ctx.payload.always ?? ctx.payload.patterns)],
          ruleset: info?.permission ?? [],
        })
        .pipe(
          Effect.map((): typeof RunnerAskResult.Type => ({ reply: answered ?? "always" })),
          Effect.catchTag("PermissionCorrectedError", (error) =>
            Effect.succeed<typeof RunnerAskResult.Type>({ reply: "reject", message: error.feedback }),
          ),
          Effect.catchTag("PermissionDeniedError", () =>
            Effect.succeed<typeof RunnerAskResult.Type>({
              reply: "reject",
              message: "Denied by the session's permission rules.",
            }),
          ),
          Effect.catchTag("PermissionRejectedError", () =>
            Effect.succeed<typeof RunnerAskResult.Type>({ reply: "reject" }),
          ),
          Effect.ensuring(unsubscribe),
        )
    })

    return handlers.handle("list", list).handle("reply", reply).handle("ask", ask)
  }),
)
