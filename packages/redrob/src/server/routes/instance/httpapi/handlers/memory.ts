import { Memory } from "@/memory/memory"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Schema } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { notFound } from "../errors"
import type { AddPayload } from "../groups/memory"

export const memoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "memory", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Memory.Service

    const list = Effect.fn("MemoryHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const add = Effect.fn("MemoryHttpApi.add")(function* (ctx: { payload: Schema.Schema.Type<typeof AddPayload> }) {
      const input = ctx.payload
      const project = input.scope === "project" ? (yield* InstanceState.context).worktree : undefined
      if (input.kind === "lesson") {
        if (!input.text?.trim()) return yield* Effect.fail(new HttpApiError.BadRequest({}))
        return yield* svc.addLesson({ text: input.text, negative: input.negative, project, repo: input.repo })
      }
      if (!input.key?.trim() || input.value === undefined) return yield* Effect.fail(new HttpApiError.BadRequest({}))
      return yield* svc.addFact({ key: input.key, value: input.value, project })
    })

    const remove = Effect.fn("MemoryHttpApi.remove")(function* (ctx: { params: { id: string } }) {
      if (!(yield* svc.remove(ctx.params.id))) return yield* Effect.fail(notFound(`Memory entry not found: ${ctx.params.id}`))
      return true
    })

    return handlers.handle("list", list).handle("add", add).handle("remove", remove)
  }),
)
