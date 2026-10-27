import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./memory.txt"
import { Memory } from "../memory/memory"
import { InstanceState } from "@/effect/instance-state"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["add_lesson", "add_fact", "list", "remove", "search"]).annotate({
    description: "What to do",
  }),
  text: Schema.optional(Schema.String).annotate({ description: "add_lesson: the rule" }),
  negative: Schema.optional(Schema.String).annotate({ description: "add_lesson: what not to do (optional)" }),
  key: Schema.optional(Schema.String).annotate({ description: "add_fact: the key, e.g. pref.language" }),
  value: Schema.optional(Schema.String).annotate({ description: "add_fact: the value" }),
  scope: Schema.optional(Schema.Literals(["global", "project"])).annotate({
    description: "add_lesson/add_fact: global (default) or this project only",
  }),
  repo: Schema.optional(Schema.String).annotate({
    description: "add_lesson: apply only in projects whose path contains this fragment (optional)",
  }),
  query: Schema.optional(Schema.String).annotate({ description: "search: substring to look for" }),
  id: Schema.optional(Schema.String).annotate({ description: "remove: the entry id from list or search" }),
})

type Metadata = {
  count?: number
  id?: string
}

function format(entries: readonly Memory.Entry[]) {
  if (entries.length === 0) return "No entries."
  return entries
    .map((entry) => {
      const where = entry.project ? `project ${entry.project}` : "global"
      const repo = entry.repo ? `, repo ${entry.repo}` : ""
      return `[${entry.id}] ${entry.kind} (${where}${repo}) ${Memory.line(entry).slice(2)}`
    })
    .join("\n")
}

function fail(message: string) {
  return Effect.die(new Error(message))
}

export const MemoryTool = Tool.define<typeof Parameters, Metadata, Memory.Service>(
  "memory",
  Effect.gen(function* () {
    const memory = yield* Memory.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const project =
            params.scope === "project" ? (yield* InstanceState.context).worktree : undefined

          switch (params.action) {
            case "list": {
              const entries = yield* memory.list()
              return { title: `${entries.length} memory entries`, output: format(entries), metadata: { count: entries.length } }
            }
            case "search": {
              if (!params.query) return yield* fail("search needs `query`")
              const entries = yield* memory.search(params.query)
              return { title: `${entries.length} matches`, output: format(entries), metadata: { count: entries.length } }
            }
            case "add_lesson": {
              if (!params.text?.trim()) return yield* fail("add_lesson needs `text`")
              yield* ctx.ask({ permission: "memory", patterns: ["*"], always: ["*"], metadata: {} })
              const entry = yield* memory.addLesson({
                text: params.text,
                negative: params.negative,
                project,
                repo: params.repo,
              })
              return { title: "Lesson saved", output: format([entry]), metadata: { id: entry.id } }
            }
            case "add_fact": {
              if (!params.key?.trim() || params.value === undefined)
                return yield* fail("add_fact needs `key` and `value`")
              yield* ctx.ask({ permission: "memory", patterns: ["*"], always: ["*"], metadata: {} })
              const entry = yield* memory.addFact({ key: params.key, value: params.value, project })
              return { title: "Fact saved", output: format([entry]), metadata: { id: entry.id } }
            }
            case "remove": {
              if (!params.id) return yield* fail("remove needs `id`")
              yield* ctx.ask({ permission: "memory", patterns: ["*"], always: ["*"], metadata: {} })
              const removed = yield* memory.remove(params.id)
              return {
                title: removed ? "Entry removed" : "No such entry",
                output: removed ? `Removed ${params.id}.` : `No entry with id ${params.id}.`,
                metadata: { id: params.id },
              }
            }
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
