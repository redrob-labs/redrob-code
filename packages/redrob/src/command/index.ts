import { LayerNode } from "@redrob-code/core/effect/layer-node"
import path from "path"
import { stat } from "node:fs/promises"
import { Global } from "@redrob-code/core/global"
import { Glob } from "@redrob-code/core/util/glob"
import { ConfigMarkdown } from "@/config/markdown"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { Effect, Layer, Context, Schema } from "effect"
import { Config } from "@/config/config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import { LegacyEvent } from "@redrob-code/schema/legacy-event"

type State = {
  commands: Record<string, Info>
}

export const Event = {
  Executed: LegacyEvent.CommandExecuted,
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown,
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
}).annotate({ identifier: "Command" })

export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
} as const

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

const CLAUDE_COMMANDS = path.join(".claude", "commands")

/** The `.claude/commands` folders that apply here: the home folder's, then each one from the project root down. */
async function claudeCommandDirs(directory: string, worktree: string): Promise<string[]> {
  const dirs: string[] = []
  const isDir = (dir: string) =>
    stat(dir)
      .then((info) => info.isDirectory())
      .catch(() => false)
  const home = path.join(Global.Path.home, CLAUDE_COMMANDS)
  if (await isDir(home)) dirs.push(home)
  const project: string[] = []
  let current = path.resolve(directory)
  const stop = path.resolve(worktree)
  for (;;) {
    const dir = path.join(current, CLAUDE_COMMANDS)
    if (dir !== home && (await isDir(dir))) project.unshift(dir)
    if (current === stop) break
    const parent = path.dirname(current)
    // Not inside the worktree (or no worktree): only the directory itself.
    if (parent === current || !stop || !current.startsWith(stop)) break
    current = parent
  }
  return [...dirs, ...project]
}

/**
 * Claude Code command files: `<name>.md` (in subfolders too; the folder only groups them), the body
 * is the prompt with `$ARGUMENTS` / `$1`.., the frontmatter may give `description`. Without one the
 * first line of the body describes it. A later folder (closer to the directory) wins.
 */
export async function claudeCommands(directory: string, worktree: string): Promise<Info[]> {
  const found = new Map<string, Info>()
  for (const dir of await claudeCommandDirs(directory, worktree)) {
    const files = await Glob.scan("**/*.md", { cwd: dir, absolute: true, include: "file", symlink: true }).catch(
      () => [] as string[],
    )
    for (const file of files.toSorted()) {
      const md = await ConfigMarkdown.parse(file).catch(() => undefined)
      if (!md) continue
      const name = path.basename(file, path.extname(file))
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(name)) continue
      const template = md.content.trim()
      const data = (md.data ?? {}) as { description?: unknown }
      const description =
        typeof data.description === "string" && data.description.trim()
          ? data.description.trim()
          : template.split("\n")[0]?.replace(/^#+\s*/, "").trim().slice(0, 200) || undefined
      found.set(name, {
        name,
        ...(description ? { description } : {}),
        source: "command",
        template,
        hints: hints(template),
      })
    }
  }
  return [...found.values()]
}

export class Service extends Context.Service<Service, Interface>()("@redrob/Command") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service
    const flags = yield* RuntimeFlags.Service

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      // Claude Code command files (`.claude/commands/*.md`), under the home folder and the project.
      // A command redrob's own config defines keeps its definition.
      if (!flags.disableClaudeCodeCommands) {
        for (const command of yield* Effect.promise(() => claudeCommands(ctx.directory, ctx.worktree))) {
          if (commands[command.name]) continue
          commands[command.name] = command
        }
      }

      for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
        commands[name] = {
          name,
          source: "mcp",
          description: prompt.description,
          get template() {
            return bridge.promise(
              mcp
                .getPrompt(
                  prompt.client,
                  prompt.name,
                  prompt.arguments
                    ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                    : {},
                )
                .pipe(
                  Effect.map(
                    (template) =>
                      template?.messages
                        .map((message) => (message.content.type === "text" ? message.content.text : ""))
                        .join("\n") || "",
                  ),
                ),
            )
          },
          hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
        }
      }

      for (const item of yield* skill.all()) {
        if (commands[item.name]) continue
        const dir = item.location === "<built-in>" ? undefined : path.dirname(item.location)
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          get template() {
            if (!dir) return item.content
            return [
              item.content,
              "",
              `Base directory for this skill: ${dir}`,
              "Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.",
            ].join("\n")
          },
          hints: [],
        }
      }

      return {
        commands,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    const get = Effect.fn("Command.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.commands[name]
    })

    const list = Effect.fn("Command.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.commands)
    })

    return Service.of({ get, list })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: () => [Config.node, MCP.node, Skill.node, RuntimeFlags.node],
})

export * as Command from "."
