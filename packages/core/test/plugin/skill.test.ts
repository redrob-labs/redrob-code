import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@redrob-code/core/effect/app-node-builder"
import { SkillPlugin } from "@redrob-code/core/plugin/skill"
import { SkillV2 } from "@redrob-code/core/skill"
import { testEffect } from "../lib/effect"
import type { PluginContext } from "@redrob-code/plugin/v2/effect"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(SkillV2.node))

describe("SkillPlugin.Plugin", () => {
  it.effect("registers the built-in customize-redrob skill", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      yield* SkillPlugin.Plugin.effect(
        host({
          // Core's service as the plugin API: the same shape, but core spells arrays readonly and the SDK's
          // generated types do not. The real host (src/plugin/host.ts) converts; this test hands it straight in.
          skill: { ...skill, reload: skill.reload } as unknown as PluginContext["skill"],
        }),
      )

      expect(yield* skill.list()).toContainEqual(
        expect.objectContaining({
          name: "customize-redrob",
          description: expect.stringContaining("redrob's own configuration"),
        }),
      )
    }),
  )
})
