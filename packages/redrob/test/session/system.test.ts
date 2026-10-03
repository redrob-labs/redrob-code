import { describe, expect, test } from "bun:test"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@redrob-code/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"
import PROMPT_INITIALIZE from "../../src/command/template/initialize.txt"
import { MCP } from "../../src/mcp"
import { testEffect } from "../lib/effect"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
  // Two armable skills, because one proves too little: with a single candidate a wiring bug
  // that armed EVERY skill and one that armed the right skill look identical.
  {
    name: "docs-skill",
    description: "Docs skill.",
    location: "/tmp/docs-skill/SKILL.md",
    content: "# docs-skill\nHow to edit a document.",
    autoInject: { keywords: ["spreadsheet", "pptx"], url: ["docs.google.com/**"] },
  },
  {
    name: "deploy-skill",
    description: "Deploy skill.",
    location: "/tmp/deploy-skill/SKILL.md",
    content: "# deploy-skill\nHow to roll back.",
    autoInject: { keywords: ["rollback"] },
  },
  // A keyword carrying the characters that break an attribute. Skill files are author
  // supplied, so this is reachable, and the first version of the armed-by attribute put the
  // raw quote straight into the tag.
  {
    name: "quoted-skill",
    description: "Quoted skill.",
    location: "/tmp/quoted-skill/SKILL.md",
    content: "# quoted-skill\nBody of the quoted skill.",
    autoInject: { keywords: ['say "hello" <now>'] },
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  LayerNode.compile(SystemPrompt.node, [
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        instructions: () =>
          Effect.succeed([
            {
              name: "guide-server",
              instructions: "Use lookup before mutate.",
              tools: [],
            },
            {
              name: "tool-server",
              instructions: "Prefer search before update.",
              tools: ["tool-server_search", "tool-server_update"],
            },
          ]),
      }),
    ],
    [
      Skill.node,
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          require: (name) => {
            const info = skills.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ],
  ]),
)

describe("session.system", () => {
  test("selects the Meta prompt for Muse Spark model IDs", () => {
    for (const id of ["meta/muse-spark-preview", "muse-spark-1.1", "muse-spark-1.2"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Spark,")
      expect(prompt).toContain("using Meta Muse Spark.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Meta prompt for Muse Glimmer model IDs", () => {
    for (const id of ["meta/muse-glimmer", "meta/muse-glimmer-30b", "muse-glimmer-30b"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Glimmer,")
      expect(prompt).toContain("using Meta Muse Glimmer.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Kimi prompt for official provider model IDs", () => {
    for (const providerID of ["kimi-for-coding", "moonshotai", "moonshotai-cn"]) {
      const prompt = SystemPrompt.provider({ providerID, api: { id: "k3" } } as Provider.Model)[0]
      expect(prompt).toContain("# Prompt and Tool Use")
    }
  })

  // The prompts inherited from opencode introduced the agent to the user as OpenCode, so a
  // reintroduced mention would come straight back out of the model.
  test("never introduces the agent by the former product name", () => {
    const ids = [
      "claude-sonnet-4-5",
      "gpt-5.6-sol",
      "gpt-5.6-codex",
      "gpt-4.1",
      "gemini-3-pro",
      "kimi-k2.5",
      "trinity-large",
      "meta/muse-spark-preview",
      "deepseek-v4",
    ]
    const offenders = ids.flatMap((id) => {
      const prompt = SystemPrompt.provider({ providerID: "redrob", api: { id } } as Provider.Model)[0]!
      return /open[\s-]*code/i.test(prompt) ? [id] : []
    })
    expect(offenders).toEqual([])
    expect(
      SystemPrompt.provider({ providerID: "redrob", api: { id: "claude-sonnet-4-5" } } as Provider.Model)[0],
    ).toContain("You are Redrob Code")
  })

  test("the /init template names the product, not the fork it came from", () => {
    expect(PROMPT_INITIALIZE).not.toMatch(/open[\s-]*code/i)
    expect(PROMPT_INITIALIZE).toContain("Redrob Code")
  })

  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
    }),
  )

  it.effect("a keyword in the prompt arms that skill's body and no other", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.armedSkills(build, { prompt: "export this as a spreadsheet please" })
      const armed = output ?? (yield* Effect.fail(new NamedError.Unknown({ message: "nothing armed" })))

      // The BODY, not the description: an armed skill is one the model is already reading.
      expect(armed).toContain("How to edit a document.")
      expect(armed).toContain('armed-by="keyword spreadsheet"')
      // The other armable skill did not match, and must not ride along.
      expect(armed).not.toContain("How to roll back.")
      // A skill with no autoInject block never arms, however the prompt reads.
      expect(armed).not.toContain("manual-skill")
    }),
  )

  it.effect("a prompt matching nothing arms nothing at all", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      // Mentions skills and documents in the abstract, matching no declared keyword.
      expect(yield* prompt.armedSkills(build, { prompt: "what skills do you have?" })).toBeUndefined()
    }),
  )

  it.effect("arming is denied with the skill permission, like the discovery list", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const denied: Agent.Info = { ...build, permission: Permission.fromConfig({ skill: "deny" }) }
      expect(yield* prompt.armedSkills(denied, { prompt: "export this as a spreadsheet" })).toBeUndefined()
    }),
  )

  it.effect("a pattern with markup characters is escaped, not emitted raw", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.armedSkills(build, { prompt: 'please say "hello" <now>' })
      const armed = output ?? (yield* Effect.fail(new NamedError.Unknown({ message: "nothing armed" })))

      expect(armed).toContain("Body of the quoted skill.")
      expect(armed).toContain("armed-by=\"keyword say &quot;hello&quot; &lt;now&gt;\"")
      // The tag must close where it is supposed to: one `">` on the opening line.
      const opening = armed.split("\n").find((line) => line.includes("quoted-skill")) ?? ""
      expect(opening.endsWith('">')).toBe(true)
    }),
  )

  it.effect("MCP output includes connected server instructions", () =>    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build)

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          '  <server name="tool-server">',
          "    Prefer search before update.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.effect("MCP output omits servers when all advertised tools are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build, Permission.fromConfig({ "tool-server_*": "deny" }))

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )
})
