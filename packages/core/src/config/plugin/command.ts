export * as ConfigCommandPlugin from "./command"

import { define } from "../../plugin/internal"
import path from "path"
import { Effect, Option, Schema } from "effect"
import { CommandV2 } from "../../command"
import { Config } from "../../config"
import { FSUtil } from "../../fs-util"
import { Global } from "../../global"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { ConfigCommand } from "../command"
import { ConfigMarkdown } from "../markdown"

const decodeCommand = Schema.decodeUnknownOption(ConfigCommand.Info)

export const Plugin = define({
  id: "config-command",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    // Claude Code commands need the home folder and the location; without them only config is read.
    const global = Option.getOrUndefined(yield* Effect.serviceOption(Global.Service))
    const location = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
    yield* ctx.command.transform(
      Effect.fn(function* (draft) {
        const documents = yield* Effect.forEach(yield* config.entries(), (entry) => {
          if (entry.type === "document") return Effect.succeed([{ commands: entry.info.commands }])
          return loadDirectory(fs, entry.path).pipe(
            Effect.map((commands) => [
              { commands: Object.fromEntries(commands.map((command) => [command.name, command.info])) },
            ]),
          )
        }).pipe(Effect.map((documents) => documents.flat()))
        // Claude Code command files first, so a command redrob's own config defines wins.
        const claude =
          global && location
            ? yield* loadClaude(fs, global.home, location.directory, location.project.directory)
            : []
        for (const command of claude) {
          if (draft.get(command.name)) continue
          draft.update(command.name, (item) => {
            item.template = command.template
            if (command.description !== undefined) item.description = command.description
          })
        }
        for (const document of documents) {
          for (const [name, command] of Object.entries(document.commands ?? {})) {
            draft.update(name, (item) => {
              item.template = command.template
              if (command.description !== undefined) item.description = command.description
              if (command.agent !== undefined) item.agent = command.agent
              if (command.model !== undefined) {
                const model = ModelV2.parse(command.model)
                item.model = { id: model.modelID, providerID: model.providerID, variant: item.model?.variant }
              }
              if (command.variant !== undefined && item.model !== undefined) {
                item.model.variant = ModelV2.VariantID.make(command.variant)
              }
              if (command.subtask !== undefined) item.subtask = command.subtask
            })
          }
        }
      }),
    )
  }),
})

/**
 * Claude Code command files (`.claude/commands/**\/<name>.md`): the home folder's, then each one
 * from the project root down to the directory; a nearer one wins. The folder only groups, the body
 * is the prompt, and a command without a `description` is described by its first line.
 */
function loadClaude(fs: FSUtil.Interface, home: string, directory: string, project: string) {
  return Effect.gen(function* () {
    if (process.env.REDROB_DISABLE_CLAUDE_CODE || process.env.REDROB_DISABLE_CLAUDE_CODE_COMMANDS) return []
    const nested = yield* fs
      .up({ targets: [path.join(".claude", "commands")], start: directory, stop: project })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    const roots = [path.join(home, ".claude", "commands"), ...nested.toReversed()]
    const found = new Map<string, { name: string; template: string; description?: string }>()
    for (const root of [...new Set(roots)]) {
      const files = yield* fs
        .glob("**/*.md", { cwd: root, absolute: true, include: "file", symlink: true })
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      for (const filepath of files.toSorted()) {
        const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
        const markdown = content === undefined ? undefined : ConfigMarkdown.parseOption(content)
        if (!markdown) continue
        const name = path.basename(filepath, ".md")
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(name)) continue
        const template = markdown.content.trim()
        const declared = (markdown.data as { description?: unknown } | undefined)?.description
        const description =
          typeof declared === "string" && declared.trim()
            ? declared.trim()
            : template.split("\n")[0]?.replace(/^#+\s*/, "").trim().slice(0, 200) || undefined
        found.set(name, { name, template, ...(description ? { description } : {}) })
      }
    }
    return [...found.values()]
  })
}

function loadDirectory(fs: FSUtil.Interface, directory: string) {
  return Effect.gen(function* () {
    const files = yield* fs
      .glob("{command,commands}/**/*.md", { cwd: directory, absolute: true, dot: true, symlink: true })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    return yield* Effect.forEach(files.toSorted(), (filepath) =>
      fs.readFileStringSafe(filepath).pipe(
        Effect.map((content) => (content === undefined ? undefined : decode(directory, filepath, content))),
        Effect.catch(() => Effect.succeed(undefined)),
      ),
    ).pipe(
      Effect.map((commands) =>
        commands.filter((command): command is { name: string; info: ConfigCommand.Info } => command !== undefined),
      ),
    )
  })
}

function decode(directory: string, filepath: string, content: string) {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return
  const info = Option.getOrUndefined(decodeCommand({ ...markdown.data, template: markdown.content.trim() }))
  if (!info) return
  return {
    name: path
      .relative(directory, filepath)
      .replaceAll("\\", "/")
      .replace(/^(command|commands)\//, "")
      .replace(/\.md$/, ""),
    info,
  }
}
