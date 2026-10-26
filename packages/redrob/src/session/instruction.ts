import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { httpClient } from "@redrob-code/core/effect/app-node-platform"
import path from "path"
import { SessionV1 } from "@redrob-code/core/v1/session"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Flag } from "@redrob-code/core/flag/flag"
import { FSUtil } from "@redrob-code/core/fs-util"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Global } from "@redrob-code/core/global"
import { ConfigMarkdown } from "@redrob-code/core/config/markdown"
import type { MessageV2 } from "./message-v2"
import type { MessageID } from "./schema"

/**
 * Steering files, the way Kiro has them: markdown under a `steering/` directory, each with an
 * optional front matter saying when it applies.
 *
 *   ---
 *   inclusion: always            # default: in the system prompt of every session
 *   inclusion: fileMatch         # attached when the agent reads a file matching fileMatchPattern
 *   fileMatchPattern: "src/**\/*.ts"   # a glob relative to the project root, or a list of them
 *   inclusion: manual            # attached when the user writes #<file name> in a message
 *   ---
 *
 * Read from `.redrob/steering/` in the project and `steering/` in the global config directory, and
 * also from `.kiro/steering/` in both places, so a Kiro project's steering works unchanged.
 */
export type Steering = {
  path: string
  name: string
  inclusion: "always" | "fileMatch" | "manual"
  patterns: string[]
  content: string
}

export function parseSteering(filepath: string, raw: string): Steering {
  const parsed = ConfigMarkdown.parseOption(raw)
  const data = (parsed?.data ?? {}) as Record<string, unknown>
  const inclusion =
    data["inclusion"] === "fileMatch" || data["inclusion"] === "manual" ? data["inclusion"] : "always"
  const pattern = data["fileMatchPattern"]
  const patterns = (Array.isArray(pattern) ? pattern : [pattern]).filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  )
  return {
    path: filepath,
    name: path.basename(filepath, path.extname(filepath)),
    inclusion,
    patterns,
    content: (parsed?.content ?? raw).trim(),
  }
}

/** True when the text names this steering file as `#name` (not part of a longer word). */
export function mentionsSteering(text: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^\\w#])#${escaped}(?![\\w-])`).test(text)
}

const steeringText = (item: Steering) => `Steering from: ${item.path}\n${item.content}`

function extract(messages: SessionV1.WithParts[]) {
  const paths = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
        if (part.state.time.compacted) continue
        const loaded = part.state.metadata?.loaded
        if (!loaded || !Array.isArray(loaded)) continue
        for (const p of loaded) {
          if (typeof p === "string") paths.add(p)
        }
      }
    }
  }
  return paths
}

export interface Interface {
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  readonly systemPaths: () => Effect.Effect<Set<string>, FSUtil.Error>
  /** `prompt` is the conversation's user text, which decides the manual steering files. */
  readonly system: (prompt?: string) => Effect.Effect<string[], FSUtil.Error>
  readonly steering: () => Effect.Effect<Steering[]>
  readonly find: (dir: string) => Effect.Effect<string | undefined, FSUtil.Error>
  readonly resolve: (
    messages: SessionV1.WithParts[],
    filepath: string,
    messageID: MessageID,
  ) => Effect.Effect<{ filepath: string; content: string }[], FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@redrob/Instruction") {}

const layer: Layer.Layer<
  Service,
  never,
  FSUtil.Service | Config.Service | Global.Service | HttpClient.HttpClient | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const globalFiles = [
      path.join(global.config, "AGENTS.md"),
      ...(!flags.disableClaudeCodePrompt ? [path.join(global.home, ".claude", "CLAUDE.md")] : []),
    ]
    const instructionFiles = [
      "AGENTS.md",
      ...(!flags.disableClaudeCodePrompt ? ["CLAUDE.md"] : []),
      "CONTEXT.md", // deprecated
    ]

    const state = yield* InstanceState.make(
      Effect.fn("Instruction.state")(() =>
        Effect.succeed({
          // Track which instruction files have already been attached for a given assistant message.
          claims: new Map<MessageID, Set<string>>(),
        }),
      ),
    )

    const relative = Effect.fnUntraced(function* (instruction: string) {
      const ctx = yield* InstanceState.context
      if (!Flag.REDROB_DISABLE_PROJECT_CONFIG) {
        return yield* fs
          .globUp(instruction, ctx.directory, ctx.worktree)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      }
      return yield* fs
        .globUp(instruction, global.config, global.config)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    })

    const read = Effect.fnUntraced(function* (filepath: string) {
      return yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
    })

    const fetch = Effect.fnUntraced(function* (url: string) {
      const res = yield* http.execute(HttpClientRequest.get(url)).pipe(
        Effect.timeout(5000),
        Effect.catch(() => Effect.succeed(null)),
      )
      if (!res) return ""
      const body = yield* res.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))))
      return new TextDecoder().decode(body)
    })

    const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
      const s = yield* InstanceState.get(state)
      s.claims.delete(messageID)
    })

    /** Every steering file in reach, project first. Unreadable files and missing directories are skipped. */
    const steering = Effect.fn("Instruction.steering")(function* () {
      const ctx = yield* InstanceState.context
      const dirs = [
        ...(!Flag.REDROB_DISABLE_PROJECT_CONFIG
          ? [path.join(ctx.worktree, ".redrob", "steering"), path.join(ctx.worktree, ".kiro", "steering")]
          : []),
        path.join(global.config, "steering"),
        path.join(global.home, ".kiro", "steering"),
      ]
      const found: Steering[] = []
      const seen = new Set<string>()
      for (const dir of dirs) {
        const files = yield* fs
          .glob("*.md", { cwd: dir, absolute: true, include: "file" })
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        for (const file of files.toSorted()) {
          const resolved = path.resolve(file)
          if (seen.has(resolved)) continue
          seen.add(resolved)
          const raw = yield* read(resolved)
          if (raw.trim()) found.push(parseSteering(resolved, raw))
        }
      }
      return found
    })

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
      const config = yield* cfg.get()
      const ctx = yield* InstanceState.context
      const paths = new Set<string>()

      for (const file of globalFiles) {
        if (yield* fs.existsSafe(file)) {
          paths.add(path.resolve(file))
          break
        }
      }

      // The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor.
      if (!Flag.REDROB_DISABLE_PROJECT_CONFIG) {
        for (const file of instructionFiles) {
          const matches = yield* fs
            .findUp(file, ctx.directory, ctx.worktree)
            .pipe(Effect.catch(() => Effect.succeed([])))
          if (matches.length > 0) {
            matches.forEach((item) => paths.add(path.resolve(item)))
            break
          }
        }
      }

      if (config.instructions) {
        for (const raw of config.instructions) {
          if (raw.startsWith("https://") || raw.startsWith("http://")) continue
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          const matches = yield* (
            path.isAbsolute(instruction)
              ? fs.glob(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                })
              : relative(instruction)
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
          matches.forEach((item) => paths.add(path.resolve(item)))
        }
      }

      return paths
    })

    const system = Effect.fn("Instruction.system")(function* (prompt?: string) {
      const config = yield* cfg.get()
      const paths = yield* systemPaths()
      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )

      const files = yield* Effect.forEach(Array.from(paths), read, { concurrency: 8 })
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })
      const steered = (yield* steering()).filter(
        (item) =>
          !paths.has(item.path) &&
          (item.inclusion === "always" || (item.inclusion === "manual" && !!prompt && mentionsSteering(prompt, item.name))),
      )

      return [
        ...Array.from(paths).flatMap((item, i) => (files[i] ? [`Instructions from: ${item}\n${files[i]}`] : [])),
        ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
        ...steered.map(steeringText),
      ]
    })

    const find = Effect.fn("Instruction.find")(function* (dir: string) {
      for (const file of instructionFiles) {
        const filepath = path.resolve(path.join(dir, file))
        if (yield* fs.existsSafe(filepath)) return filepath
      }
      return undefined
    })

    const resolve = Effect.fn("Instruction.resolve")(function* (
      messages: SessionV1.WithParts[],
      filepath: string,
      messageID: MessageID,
    ) {
      const sys = yield* systemPaths()
      const already = extract(messages)
      const results: { filepath: string; content: string }[] = []
      const s = yield* InstanceState.get(state)
      const root = path.resolve(yield* InstanceState.directory)

      const target = path.resolve(filepath)
      let current = path.dirname(target)

      // Walk upward from the file being read and attach nearby instruction files once per message.
      while (current.startsWith(root) && current !== root) {
        const found = yield* find(current)
        if (!found || found === target || sys.has(found) || already.has(found)) {
          current = path.dirname(current)
          continue
        }

        let set = s.claims.get(messageID)
        if (!set) {
          set = new Set()
          s.claims.set(messageID, set)
        }
        if (set.has(found)) {
          current = path.dirname(current)
          continue
        }

        set.add(found)
        const content = yield* read(found)
        if (content) {
          results.push({ filepath: found, content: `Instructions from: ${found}\n${content}` })
        }

        current = path.dirname(current)
      }

      // fileMatch steering: attached the first time this message reads a file its pattern covers.
      const ctx = yield* InstanceState.context
      const relativeTarget = path.relative(ctx.worktree, target).split(path.sep).join("/")
      if (!relativeTarget.startsWith("..")) {
        for (const item of yield* steering()) {
          if (item.inclusion !== "fileMatch" || already.has(item.path)) continue
          if (!item.patterns.some((pattern) => new Bun.Glob(pattern).match(relativeTarget))) continue
          let set = s.claims.get(messageID)
          if (!set) {
            set = new Set()
            s.claims.set(messageID, set)
          }
          if (set.has(item.path)) continue
          set.add(item.path)
          results.push({ filepath: item.path, content: steeringText(item) })
        }
      }

      return results
    })

    return Service.of({ clear, systemPaths, system, steering, find, resolve })
  }),
)

export function loaded(messages: SessionV1.WithParts[]) {
  return extract(messages)
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: () => [Config.node, FSUtil.node, Global.node, RuntimeFlags.node, httpClient],
})

export * as Instruction from "./instruction"
