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
  kind: Schema.optional(Schema.Literals(["github_pr", "ci_run", "url", "command"])).annotate({
    description: "For a watch: what to poll (default github_pr)",
  }),
  url: Schema.optional(Schema.String).annotate({
    description: "For a watch: the pull request URL, the GitHub Actions run URL, or the http(s) URL to poll",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "For a command watch: the shell command to run" }),
  interval: Schema.optional(Schema.Number).annotate({
    description: "For a watch: seconds between polls (default 300)",
  }),
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
        ? `watching ${trigger.kind === "command" ? `\`${trigger.command}\`` : trigger.url}`
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
    const kind = params.kind ?? "github_pr"
    if (kind === "command" ? !params.command : !params.url)
      return kind === "command" ? "A command watch needs `command`." : "A watch needs `url`."
    return {
      type: "watch",
      kind,
      ...(params.url !== undefined ? { url: params.url } : {}),
      ...(params.command !== undefined ? { command: params.command } : {}),
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

          // A command watch runs a shell command on every poll, unattended: it passes the bash rules first.
          if (trigger.type === "watch" && trigger.kind === "command" && trigger.command) {
            yield* ctx.ask({ permission: "bash", patterns: [trigger.command], always: [], metadata: { command: trigger.command } })
          }
          // Asked before anything is stored: a routine spends turns later, when nobody is watching.
          yield* ctx.ask({
            permission: "routine",
            patterns: [
              trigger.type === "watch"
                ? (trigger.url ?? trigger.command ?? "watch")
                : trigger.type === "schedule"
                  ? (trigger.cron ?? `every ${trigger.every}s`)
                  : "after_turn",
            ],
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
          Effect.catchTag("Routine.NotFoundError", (error) => Effect.fail(new Error(error.message))),
          // As the other tools do: a thrown error becomes the tool call's error text.
          Effect.orDie,
        ),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
