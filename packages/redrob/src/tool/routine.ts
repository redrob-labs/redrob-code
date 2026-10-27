import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./routine.txt"
import { InstanceState } from "@/effect/instance-state"
import { Routine } from "@/routine/store"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["create", "list", "stop"]).annotate({ description: "What to do" }),
  trigger: Schema.optional(Schema.Literals(["schedule", "watch"])).annotate({
    description: "For create: what wakes the routine",
  }),
  goal: Schema.optional(Schema.String).annotate({
    description: "For create: the full instruction every run acts on",
  }),
  cron: Schema.optional(Schema.String).annotate({ description: "For a schedule: 5-field cron expression" }),
  every: Schema.optional(Schema.Number).annotate({ description: "For a schedule: interval in seconds (min 60)" }),
  timezone: Schema.optional(Schema.String).annotate({ description: "For a cron schedule: IANA time zone" }),
  url: Schema.optional(Schema.String).annotate({ description: "For a watch: full GitHub pull request URL" }),
  interval: Schema.optional(Schema.Number).annotate({ description: "For a watch: seconds between polls (default 300)" }),
  maxRuns: Schema.optional(Schema.Number).annotate({ description: "For create: most runs before it stops itself" }),
  id: Schema.optional(Schema.String).annotate({ description: "For stop: the routine id" }),
})

type Metadata = {
  routines: readonly Routine.Info[]
}

const describe = (info: Routine.Info) => {
  const trigger = info.trigger
  const when =
    trigger.type === "schedule"
      ? trigger.cron
        ? `cron "${trigger.cron}"${trigger.timezone ? ` (${trigger.timezone})` : ""}`
        : `every ${trigger.every}s`
      : trigger.type === "watch"
        ? `watching ${trigger.url}`
        : "autopilot"
  return `${info.id} [${info.status}] ${when}, ${info.cycles}/${info.maxCycles} runs: ${info.goal}`
}

const triggerOf = (params: Schema.Schema.Type<typeof Parameters>): Routine.Trigger | string => {
  if (params.trigger === "schedule") {
    return {
      type: "schedule",
      ...(params.cron !== undefined ? { cron: params.cron } : {}),
      ...(params.every !== undefined ? { every: Math.round(params.every) } : {}),
      ...(params.timezone !== undefined ? { timezone: params.timezone } : {}),
    }
  }
  if (params.trigger === "watch") {
    if (!params.url) return "A watch needs `url`."
    return {
      type: "watch",
      kind: "github_pr",
      url: params.url,
      ...(params.interval !== undefined ? { interval: Math.round(params.interval) } : {}),
    }
  }
  return "create needs `trigger`: schedule or watch."
}

export const RoutineTool = Tool.define<typeof Parameters, Metadata, Routine.Service>(
  "routine",
  Effect.gen(function* () {
    const routines = yield* Routine.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          if (params.action === "list") {
            const list = yield* routines.list({ sessionID: ctx.sessionID })
            return {
              title: `${list.length} routine${list.length === 1 ? "" : "s"}`,
              output: list.length > 0 ? list.map(describe).join("\n") : "No routines in this session.",
              metadata: { routines: list },
            }
          }

          if (params.action === "stop") {
            if (!params.id) return yield* Effect.fail(new Error("stop needs `id`."))
            yield* ctx.ask({ permission: "routine", patterns: [params.id], always: ["*"], metadata: {} })
            const info = yield* routines.stop(Routine.ID.make(params.id), "Stopped by the agent.")
            return { title: `Stopped ${info.id}`, output: describe(info), metadata: { routines: [info] } }
          }

          const trigger = triggerOf(params)
          if (typeof trigger === "string") return yield* Effect.fail(new Error(trigger))
          const goal = params.goal?.trim()
          if (!goal) return yield* Effect.fail(new Error("create needs `goal`."))

          // Asked before anything is stored: a routine spends turns later, when nobody is watching.
          yield* ctx.ask({
            permission: "routine",
            patterns: [trigger.type === "watch" ? trigger.url : (trigger.cron ?? `every ${trigger.every}s`)],
            always: ["*"],
            metadata: { goal, trigger },
          })

          const info = yield* routines.create({
            sessionID: ctx.sessionID,
            directory: yield* InstanceState.directory,
            goal,
            trigger,
            ...(params.maxRuns !== undefined ? { maxCycles: Math.max(1, Math.round(params.maxRuns)) } : {}),
          })
          return { title: `Created ${info.id}`, output: describe(info), metadata: { routines: [info] } }
        }).pipe(
          Effect.catchTag("Routine.InvalidError", (error) => Effect.fail(new Error(error.message))),
          Effect.catchTag("Routine.NotFoundError", (error) => Effect.fail(new Error(error.message))),
          // As the other tools do: a thrown error becomes the tool call's error text.
          Effect.orDie,
        ),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
