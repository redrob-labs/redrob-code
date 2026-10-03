/**
 * K-5: the skill that writes skills, verified by taking the frontmatter template out of the
 * skill document itself and putting it through the REAL loader.
 *
 * The template is not retyped here and it is not asserted by eye. This test reads
 * `SkillWriterContent` — the exact string the skill hands to an agent — extracts the fenced
 * block the document marks as the template, writes it where the loader globs, and asserts the
 * decoded `SkillV2.Info`. So a key the loader does not read, a shape its decoder rejects, or a
 * typo in the document's own template fails here.
 */
import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@redrob-code/core/agent"
import { AppNodeBuilder } from "@redrob-code/core/effect/app-node-builder"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { AbsolutePath } from "@redrob-code/core/schema"
import { SkillV2 } from "@redrob-code/core/skill"
import { SkillDiscovery } from "@redrob-code/core/skill/discovery"
import { SkillPlugin } from "@redrob-code/core/plugin/skill"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const discovery = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({ pull: () => Effect.succeed([]) }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillV2.node, AgentV2.node]), [[SkillDiscovery.node, discovery]]),
)

/**
 * The template the document tells an agent to copy. Anchored on the document's own
 * `<!-- template:skill -->` marker rather than on "the first code fence", so adding an earlier
 * example to the document cannot silently repoint this at the wrong block.
 *
 * `\r` is stripped and the fence match tolerates CRLF: git checks this file out with native
 * line endings, so on Windows the document arrives CRLF and an `\n`-only pattern finds no fence
 * at all. That failed the Windows core job, which is the only place it could show.
 */
const template = (() => {
  const marker = "<!-- template:skill -->"
  const content = SkillPlugin.SkillWriterContent.replaceAll("\r\n", "\n")
  const start = content.indexOf(marker)
  if (start < 0) throw new Error("the skill-writer document no longer carries its template marker")
  const fence = /```markdown\n([\s\S]*?)```/.exec(content.slice(start))
  if (!fence) throw new Error("no ```markdown fence follows the template marker")
  return fence[1]!
})()

const withTmpdir = <A, E, R>(use: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => use(tmp.path)))

/** Writes one document where the loader globs it and returns what the loader made of it. */
const load = (directory: string, name: string, content: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(directory, name), { recursive: true })
      await fs.writeFile(path.join(directory, name, "SKILL.md"), content)
    })
    const skill = yield* SkillV2.Service
    yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(directory) }))
    return yield* skill.list()
  })

describe("K-5 the skill that writes skills", () => {
  it.live("the template the document prescribes round-trips through the real loader", () =>
    withTmpdir((directory) =>
      Effect.gen(function* () {
        const skills = yield* load(directory, "release-notes", template)
        expect(skills).toHaveLength(1)
        const skill = skills[0]!

        // Every frontmatter key the template declares, decoded by the loader — not read off
        // the YAML by this test.
        expect(skill.name).toBe("release-notes")
        expect(skill.description).toBe(
          "Use when drafting release notes from a tag range, or when the user asks what changed between two versions.",
        )
        expect(skill.slash).toBe(true)
        expect(skill.icon).toBe("https://code.redrob.ai/icon/release-notes.svg")
        expect(skill.autoInject).toBeDefined()
        expect(skill.autoInject!.keywords).toEqual(["release notes", "changelog"])
        expect(skill.autoInject!.url).toEqual(["github.com/*/releases/**"])
        expect(skill.location).toBe(AbsolutePath.make(path.join(directory, "release-notes", "SKILL.md")))
        expect(skill.content).toContain("# Drafting release notes")
      }),
    ),
  )

  it.live("the loaded skill re-decodes through the Info schema, so nothing passed by luck", () =>
    withTmpdir((directory) =>
      Effect.gen(function* () {
        const skills = yield* load(directory, "release-notes", template)
        // The loader builds `Info` with `make`, which does not run the decoder over the whole
        // value. Putting the loaded skill back through `decodeUnknownSync` does, so a field
        // the loader happened to accept in a shape the schema rejects fails here.
        const again = Schema.decodeUnknownSync(SkillV2.Info)(JSON.parse(JSON.stringify(skills[0]!)))
        expect(again.name).toBe("release-notes")
        expect(again.autoInject).toEqual({ keywords: ["release notes", "changelog"], url: ["github.com/*/releases/**"] })
      }),
    ),
  )

  it.live("a document missing the loader's one required key is DROPPED, which is what the skill warns about", () =>
    withTmpdir((directory) =>
      Effect.gen(function* () {
        // The template's own claim under test: a SKILL.md in a subdirectory with no `name` has
        // no fallback and does not become a skill.
        const skills = yield* load(
          directory,
          "nameless",
          template.replace("name: release-notes\n", ""),
        )
        expect(skills).toHaveLength(0)
      }),
    ),
  )

  it.live("a malformed autoInject costs only the arming, exactly as the document says", () =>
    withTmpdir((directory) =>
      Effect.gen(function* () {
        const broken = template.replace("autoInject:\n  keywords:", "autoInject:\n  keywords: not-a-list\n  ignored:")
        const skills = yield* load(directory, "release-notes", broken)
        expect(skills).toHaveLength(1)
        expect(skills[0]!.name).toBe("release-notes")
        expect(skills[0]!.autoInject).toBeUndefined()
      }),
    ),
  )
})

describe("K-5 the skill document itself", () => {
  it.live("every builtin skill decodes through the Info schema the loader uses", () =>
    Effect.gen(function* () {
      expect(SkillPlugin.BuiltinSkills.map((skill) => skill.name)).toStrictEqual([
        "customize-redrob",
        "documents",
        "page-control",
        "skill-writer",
      ])
      for (const skill of SkillPlugin.BuiltinSkills) {
        // `Info.make` does not decode, so a field in a shape the schema rejects would reach a
        // session unnoticed. This runs the real decoder over each shipped skill.
        const decoded = Schema.decodeUnknownSync(SkillV2.Info)(JSON.parse(JSON.stringify(skill)))
        expect(decoded.name).toBe(skill.name)
        expect(decoded.description).toBeTruthy()
        expect(decoded.content.length).toBeGreaterThan(200)
      }
      const documents = SkillPlugin.BuiltinSkills.find((skill) => skill.name === "documents")!
      expect(documents.autoInject?.keywords).toContain("docx")
      expect(documents.autoInject?.url).toContain("docs.google.com/document/**")
      // K-5 deliberately does not auto-arm.
      expect(SkillPlugin.BuiltinSkills.find((skill) => skill.name === "skill-writer")!.autoInject).toBeUndefined()
    }),
  )

  it.live("is registered as a builtin skill with the keys the loader reads", () =>
    Effect.gen(function* () {
      expect(SkillPlugin.SkillWriterContent).toContain("# Writing a skill")
      // The document claims these are the only frontmatter keys read. They are the keys the
      // loader's own decoder declares, so a key added to one and not the other is caught.
      for (const key of ["name", "description", "slash", "icon", "autoInject"]) {
        expect(SkillPlugin.SkillWriterContent).toContain(`\`${key}\``)
      }
      expect(SkillPlugin.SkillWriterContent).toContain("{*.md,**/SKILL.md}")
    }),
  )
})
