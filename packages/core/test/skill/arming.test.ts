import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { AgentV2 } from "@redrob-code/core/agent"
import { AppNodeBuilder } from "@redrob-code/core/effect/app-node-builder"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { AbsolutePath } from "@redrob-code/core/schema"
import { SkillV2 } from "@redrob-code/core/skill"
import { SkillArming } from "@redrob-code/core/skill/arming"
import { SkillDiscovery } from "@redrob-code/core/skill/discovery"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

/** `arm` is pure, so most of K-2 needs no layer, no filesystem and no clock. */
const skill = (name: string, autoInject?: SkillV2.AutoInject): SkillArming.Armable => ({ name, autoInject })

const names = (input: SkillArming.Input) => SkillArming.armedNames(input)

describe("SkillArming.arm", () => {
  const docs = skill("google-docs", { url: ["docs.google.com/document/**"] })
  const deploy = skill("deploy", { keywords: ["deploy", "rollback"] })
  /** No `autoInject` block at all: explicitly loadable, never auto-armed. */
  const manual = skill("manual")

  test("arms on a keyword hit", () => {
    expect(names({ skills: [deploy, manual], prompt: "can you deploy this branch" })).toEqual(["deploy"])
  })

  test("reports which keyword armed the skill", () => {
    expect(SkillArming.arm({ skills: [deploy], prompt: "time to ROLLBACK" })).toEqual([
      { name: "deploy", keywords: ["rollback"], urls: [] },
    ])
  })

  test("keyword matching is case-insensitive in both directions", () => {
    expect(names({ skills: [skill("x", { keywords: ["RollBack"] })], prompt: "rollback now" })).toEqual(["x"])
  })

  test("a keyword does not match inside a longer word", () => {
    expect(names({ skills: [skill("ai", { keywords: ["ai"] })], prompt: "she said nothing" })).toEqual([])
  })

  test("arms on a URL-glob hit", () => {
    expect(
      names({
        skills: [docs, manual],
        prompt: "summarise this",
        url: "https://docs.google.com/document/d/abc123/edit",
      }),
    ).toEqual(["google-docs"])
  })

  test("URL matching ignores the scheme and is case-insensitive", () => {
    expect(names({ skills: [docs], prompt: "", url: "HTTPS://Docs.Google.com/Document/d/ABC" })).toEqual([
      "google-docs",
    ])
  })

  test("a glob NEAR-MISS does not arm", () => {
    // `documents` is not `document`, and a single `*` does not cross a `/`.
    expect(names({ skills: [docs], prompt: "", url: "https://docs.google.com/documents/d/abc" })).toEqual([])
    expect(
      names({
        skills: [skill("one-segment", { url: ["docs.google.com/document/*"] })],
        prompt: "",
        url: "https://docs.google.com/document/d/abc",
      }),
    ).toEqual([])
    // A `.` in the glob is a literal dot, not a regex wildcard.
    expect(names({ skills: [docs], prompt: "", url: "https://docsXgoogle.com/document/d/abc" })).toEqual([])
  })

  test("a skill with no autoInject block NEVER arms", () => {
    expect(
      names({ skills: [manual], prompt: "manual deploy rollback everything", url: "docs.google.com/document/d/abc" }),
    ).toEqual([])
  })

  test("an empty autoInject block matches nothing", () => {
    expect(names({ skills: [skill("empty", {})], prompt: "deploy", url: "docs.google.com/document/d/a" })).toEqual([])
  })

  test("no current URL means no glob can arm", () => {
    expect(names({ skills: [docs], prompt: "summarise this" })).toEqual([])
  })

  test("keyword and URL hits are both reported on one skill", () => {
    expect(
      SkillArming.arm({
        skills: [skill("both", { keywords: ["summarise"], url: ["docs.google.com/**"] })],
        prompt: "Summarise it",
        url: "https://docs.google.com/document/d/a",
      }),
    ).toEqual([{ name: "both", keywords: ["summarise"], urls: ["docs.google.com/**"] }])
  })

  test("skills are returned in the order given", () => {
    expect(names({ skills: [deploy, manual, skill("also", { keywords: ["deploy"] })], prompt: "deploy" })).toEqual([
      "deploy",
      "also",
    ])
  })
})

const urls = new Map<string, AbsolutePath[]>()
const discovery = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({ pull: (url) => Effect.succeed(urls.get(url) ?? []) }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillV2.node, AgentV2.node]), [[SkillDiscovery.node, discovery]]),
)

describe("SkillV2.load frontmatter", () => {
  it.live("ignores a malformed autoInject instead of failing the load, and drops only the bad document", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            // `autoInject` is a string where the schema wants an object: ignored, not fatal.
            await fs.writeFile(
              path.join(tmp.path, "broken-block.md"),
              "---\nname: broken-block\nautoInject: nonsense\n---\n# broken-block",
            )
            // A good neighbour, to prove one bad document does not cost the set.
            await fs.writeFile(
              path.join(tmp.path, "good.md"),
              "---\nname: good\nicon: https://example.test/i.png\nautoInject:\n  keywords: [deploy]\n  url: [docs.google.com/document/**]\n---\n# good",
            )
            // `slash` must be a boolean: this document IS dropped, with a logged reason.
            await fs.writeFile(path.join(tmp.path, "bad-type.md"), "---\nname: bad-type\nslash: yes please\n---\n# bad")
          })

          const skills = yield* SkillV2.Service
          yield* skills.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(tmp.path) }))
          const loaded = yield* skills.list()

          // The undecodable document is gone; the two others survived.
          expect(loaded.map((item) => item.name).toSorted()).toEqual(["broken-block", "good"])

          const broken = loaded.find((item) => item.name === "broken-block")!
          expect(broken.autoInject).toBeUndefined()
          // Still loadable, just never auto-armed.
          expect(names({ skills: [broken], prompt: "nonsense" })).toEqual([])

          const good = loaded.find((item) => item.name === "good")!
          expect(good.icon).toBe("https://example.test/i.png")
          expect(good.autoInject).toEqual({ keywords: ["deploy"], url: ["docs.google.com/document/**"] })
          expect(names({ skills: [good], prompt: "please deploy" })).toEqual(["good"])
          expect(names({ skills: [good], prompt: "", url: "https://docs.google.com/document/d/x" })).toEqual(["good"])

          // The drop must be FINDABLE: the count, the offending file and the reason all logged.
          const logged = (yield* TestConsole.logLines).map((line) => String(line)).join("\n")
          expect(logged).toContain("SkillV2.load dropped 1 of 3 skill documents")
          expect(logged).toContain("bad-type.md")
          expect(logged).toContain("frontmatter rejected")
          expect(logged).toContain("ignored a malformed autoInject block")
          expect(logged).toContain("broken-block.md")
          // The documents that loaded are not reported as dropped.
          expect(logged).not.toContain("good.md:")
        }),
      ),
    ),
  )
})
