import { describe, expect } from "bun:test"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { CrossSpawnSpawner } from "@redrob-code/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import path from "path"
import { Command } from "../../src/command"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const spawner = LayerNode.compile(CrossSpawnSpawner.node)
const it = testEffect(Layer.mergeAll(LayerNode.compile(Command.node), spawner, testInstanceStoreLayer))
const itDisabled = testEffect(
  Layer.mergeAll(
    LayerNode.compile(Command.node, [[RuntimeFlags.node, RuntimeFlags.layer({ disableClaudeCodeCommands: true })]]),
    spawner,
    testInstanceStoreLayer,
  ),
)

const write = (dir: string) =>
  Effect.promise(async () => {
    await Bun.write(
      path.join(dir, ".claude", "commands", "fix-issue.md"),
      `---
description: Fix a GitHub issue
argument-hint: <number>
---

Fix issue #$ARGUMENTS and add a test.
`,
    )
    await Bun.write(path.join(dir, ".claude", "commands", "frontend", "component.md"), "# Make a component\n\nMake $1.\n")
  })

describe("claude code commands", () => {
  it.live("reads .claude/commands/*.md as commands", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* write(dir)
          const commands = yield* (yield* Command.Service).list()
          const fix = commands.find((command) => command.name === "fix-issue")
          expect(fix).toMatchObject({
            name: "fix-issue",
            description: "Fix a GitHub issue",
            source: "command",
            template: "Fix issue #$ARGUMENTS and add a test.",
            hints: ["$ARGUMENTS"],
          })
          // A subfolder only groups; the first line describes a command without frontmatter.
          expect(commands.find((command) => command.name === "component")).toMatchObject({
            description: "Make a component",
            hints: ["$1"],
          })
          // The built-in ones stay.
          expect(commands.map((command) => command.name)).toContain("init")
        }),
      { git: true },
    ),
  )

  itDisabled.live("REDROB_DISABLE_CLAUDE_CODE_COMMANDS turns them off", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* write(dir)
          const commands = yield* (yield* Command.Service).list()
          expect(commands.find((command) => command.name === "fix-issue")).toBeUndefined()
        }),
      { git: true },
    ),
  )
})
