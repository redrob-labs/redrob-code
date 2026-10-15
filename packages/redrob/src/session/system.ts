import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"
import PROMPT_META from "./prompt/meta.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { SkillArming } from "@redrob-code/core/skill/arming"
import { escapeHtml } from "@/util/html"
import { AbsolutePath } from "@redrob-code/core/schema"
import { Location } from "@redrob-code/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@redrob-code/core/location-services"
import { Reference } from "@redrob-code/core/reference"
import { MCP } from "@/mcp"
import { PermissionV1 } from "@redrob-code/core/v1/permission"

export function provider(model: Provider.Model) {
  if (model.api.id.includes("muse")) {
    const name = model.api.id.includes("muse-glimmer") ? "Muse Glimmer" : "Muse Spark"
    return [PROMPT_META.replaceAll("{{MODEL_NAME}}", name)]
  }
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (
    model.api.id.toLowerCase().includes("kimi") ||
    ["kimi-for-coding", "moonshotai", "moonshotai-cn"].includes(model.providerID)
  )
    return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  /**
   * The bodies of the skills this prompt armed, as their own block.
   *
   * Separate from `skills` because the two make different claims. `skills` is the
   * discovery list -- names and descriptions, for the model to choose from with the skill
   * tool. This is the content of the ones that armed themselves on what the user just
   * typed, or on the page they are looking at, which the model did not ask for and must
   * therefore be told it is reading.
   */
  readonly armedSkills: (
    agent: Agent.Info,
    input: { readonly prompt: string; readonly url?: string | undefined },
  ) => Effect.Effect<string | undefined>
  readonly mcp: (agent: Agent.Info, permission?: PermissionV1.Ruleset) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@redrob/SystemPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const mcp = yield* MCP.Service
    const locations = yield* LocationServiceMap.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        const references = yield* Effect.gen(function* () {
          return (yield* (yield* Reference.Service).list()).filter((reference) => reference.description !== undefined)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
          references.length === 0
            ? undefined
            : [
                "Project references provide additional directories that can be accessed when relevant.",
                "<available_references>",
                ...references
                  .toSorted((a, b) => a.name.localeCompare(b.name))
                  .flatMap((reference) => [
                    "  <reference>",
                    `    <name>${reference.name}</name>`,
                    `    <path>${reference.path}</path>`,
                    ...(reference.description === undefined
                      ? []
                      : [`    <description>${reference.description}</description>`]),
                    "  </reference>",
                  ]),
                "</available_references>",
              ].join("\n"),
        ].filter((part): part is string => part !== undefined)
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),

      /**
       * Arm the skills whose own `autoInject` block matches, and hand over their bodies.
       *
       * K-2 landed the matcher as a pure function and nothing called it, so every skill
       * that declared keywords and URL globs behaved exactly like one that declared none.
       * This is the call.
       *
       * Two properties are deliberate and both are about not drowning the prompt. A skill
       * with no `autoInject` never arms, so the shipped `skill-writer` stays
       * ask-for-it-by-name. And the armed bodies are labelled as armed, with the patterns
       * that armed them: a model handed a document toolchain it never requested should be
       * able to see why, and so should anyone reading the transcript.
       */
      armedSkills: Effect.fn("SystemPrompt.armedSkills")(function* (
        agent: Agent.Info,
        input: { readonly prompt: string; readonly url?: string | undefined },
      ) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)
        const armed = SkillArming.arm({ skills: list, prompt: input.prompt, url: input.url })
        if (armed.length === 0) return

        const byName = new Map(list.map((entry) => [entry.name, entry] as const))
        const sections: string[] = []
        for (const entry of armed) {
          const info = byName.get(entry.name)
          // `arm` only ever returns names it was given, so a miss here is impossible rather
          // than unlikely -- but a skill with no content would silently contribute an empty
          // section, which reads as a skill that said nothing.
          if (info === undefined || info.content.trim().length === 0) continue
          const why = [
            ...entry.keywords.map((keyword) => `keyword ${keyword}`),
            ...entry.urls.map((glob) => `url ${glob}`),
          ].join(", ")
          // Escaped with the repo's own helper: a keyword or URL glob is author-supplied
          // text from a skill file, and the first version of this used `JSON.stringify`,
          // which put a raw `"` inside the attribute and broke the tag.
          sections.push(`  <skill name="${entry.name}" armed-by="${escapeHtml(why)}">`, info.content, `  </skill>`)
        }
        if (sections.length === 0) return

        return [
          "<armed_skills>",
          "These skills armed themselves on this request -- their own autoInject block matched",
          "what the user typed, or the page they are on. You did not load them with the skill",
          "tool; they are here already, so do not load them again.",
          ...sections,
          "</armed_skills>",
        ].join("\n")
      }),

      mcp: Effect.fn("SystemPrompt.mcp")(function* (agent: Agent.Info, permission?: PermissionV1.Ruleset) {
        const ruleset = Permission.merge(agent.permission, permission ?? [])
        const instructions = (yield* mcp.instructions()).filter(
          (item) => item.tools.length === 0 || Permission.disabled(item.tools, ruleset).size < item.tools.length,
        )
        if (instructions.length === 0) return

        return [
          "<mcp_instructions>",
          ...instructions.flatMap((item) => [
            `  <server name="${item.name}">`,
            ...item.instructions.split("\n").map((line) => `    ${line}`),
            "  </server>",
          ]),
          "</mcp_instructions>",
        ].join("\n")
      }),
    })
  }),
)

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: () => [],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: () => [Skill.node, MCP.node, locationServiceMapNode],
})

export * as SystemPrompt from "./system"
