/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeRedrobContent from "./skill/customize-redrob.md" with { type: "text" }

export const CustomizeRedrobContent = customizeRedrobContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-redrob",
            description:
              "Use ONLY when the user is editing or creating redrob's own configuration: redrob.json, redrob.jsonc, files under .redrob/, or files under ~/.config/redrob/. Also use when creating or fixing redrob agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring redrob itself.",
            location: AbsolutePath.make("/builtin/customize-redrob.md"),
            content: CustomizeRedrobContent,
          }),
        }),
      )
    })
  }),
})
