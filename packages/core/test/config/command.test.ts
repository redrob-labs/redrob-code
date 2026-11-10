import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { CommandV2 } from "@redrob-code/core/command"
import { Config } from "@redrob-code/core/config"
import { ConfigCommandPlugin } from "@redrob-code/core/config/plugin/command"
import { AppNodeBuilder } from "@redrob-code/core/effect/app-node-builder"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { FSUtil } from "@redrob-code/core/fs-util"
import { ModelV2 } from "@redrob-code/core/model"
import { ProviderV2 } from "@redrob-code/core/provider"
import { AbsolutePath } from "@redrob-code/core/schema"
import { Global } from "@redrob-code/core/global"
import { Location } from "@redrob-code/core/location"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([CommandV2.node, FSUtil.node])))
const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigCommandPlugin.Plugin", () => {
  it.live("loads inline and file-based commands in config order", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "commands", "nested"), { recursive: true })
            await fs.writeFile(
              path.join(tmp.path, "commands", "review.md"),
              `---
description: File review
agent: reviewer
model: anthropic/claude
variant: high
subtask: true
---
Review files`,
            )
            await fs.writeFile(path.join(tmp.path, "commands", "nested", "docs.md"), "Write docs")
            await fs.writeFile(path.join(tmp.path, "commands", "empty.md"), "")
          })

          const command = yield* CommandV2.Service
          yield* ConfigCommandPlugin.Plugin.effect(host({ command: { ...command, reload: command.reload } })).pipe(
            Effect.provideService(
              Config.Service,
              Config.Service.of({
                entries: () =>
                  Effect.succeed([
                    new Config.Document({
                      type: "document",
                      info: decode({ commands: { review: { template: "Inline review" } } }),
                    }),
                    new Config.Directory({ type: "directory", path: AbsolutePath.make(tmp.path) }),
                  ]),
              }),
            ),
          )

          expect(yield* command.list()).toEqual([
            CommandV2.Info.make({
              name: "review",
              template: "Review files",
              description: "File review",
              agent: "reviewer",
              model: {
                providerID: ProviderV2.ID.make("anthropic"),
                id: ModelV2.ID.make("claude"),
                variant: ModelV2.VariantID.make("high"),
              },
              subtask: true,
            }),
            CommandV2.Info.make({ name: "empty", template: "" }),
            CommandV2.Info.make({ name: "nested/docs", template: "Write docs" }),
          ])
        }),
      ),
    ),
  )

  it.live("reads Claude Code .claude/commands, with redrob config winning a shared name", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "repo")
          const home = path.join(tmp.path, "home")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(project, ".claude", "commands", "frontend"), { recursive: true })
            await fs.mkdir(path.join(home, ".claude", "commands"), { recursive: true })
            await fs.writeFile(
              path.join(project, ".claude", "commands", "fix-issue.md"),
              "---\ndescription: Fix a GitHub issue\nargument-hint: <number>\n---\nFix issue #$ARGUMENTS.",
            )
            await fs.writeFile(path.join(project, ".claude", "commands", "frontend", "component.md"), "# Make one\nMake $1.")
            await fs.writeFile(path.join(project, ".claude", "commands", "review.md"), "Claude review")
            await fs.writeFile(path.join(home, ".claude", "commands", "standup.md"), "Write my standup.")
          })

          const command = yield* CommandV2.Service
          yield* ConfigCommandPlugin.Plugin.effect(host({ command: { ...command, reload: command.reload } })).pipe(
            Effect.provideService(
              Config.Service,
              Config.Service.of({
                entries: () =>
                  Effect.succeed([
                    new Config.Document({
                      type: "document",
                      info: decode({ commands: { review: { template: "Inline review" } } }),
                    }),
                  ]),
              }),
            ),
            Effect.provideService(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(project) }))),
            Effect.provideService(Global.Service, Global.Service.of({ ...Global.Path, home })),
          )

          const list = yield* command.list()
          expect(list.find((item) => item.name === "fix-issue")).toEqual(
            CommandV2.Info.make({ name: "fix-issue", template: "Fix issue #$ARGUMENTS.", description: "Fix a GitHub issue" }),
          )
          expect(list.find((item) => item.name === "component")).toEqual(
            CommandV2.Info.make({ name: "component", template: "# Make one\nMake $1.", description: "Make one" }),
          )
          expect(list.find((item) => item.name === "standup")?.template).toBe("Write my standup.")
          expect(list.find((item) => item.name === "review")?.template).toBe("Inline review")
        }),
      ),
    ),
  )
})
