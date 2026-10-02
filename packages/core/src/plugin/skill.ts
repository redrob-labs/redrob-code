/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeRedrobContent from "./skill/customize-redrob.md" with { type: "text" }
import documentToolchainContent from "./skill/document-toolchain.md" with { type: "text" }
import skillWriterContent from "./skill/skill-writer.md" with { type: "text" }

export const CustomizeRedrobContent = customizeRedrobContent

/** K-3's skill document. Exported so a test can assert its claims against the real tool tree. */
export const DocumentToolchainContent = documentToolchainContent

/** K-5's skill document. Exported so a test can round-trip the template it prescribes. */
export const SkillWriterContent = skillWriterContent

/**
 * The skills the engine ships with. Exported as data rather than built inline in the plugin
 * effect so a test can decode every entry through `SkillV2.Info` — `Info.make` does not run
 * the decoder, so a field in a shape the schema rejects would otherwise reach a session.
 */
export const BuiltinSkills: ReadonlyArray<SkillV2.Info> = [
  SkillV2.Info.make({
    name: "customize-redrob",
    description:
      "Use ONLY when the user is editing or creating redrob's own configuration: redrob.json, redrob.jsonc, files under .redrob/, or files under ~/.config/redrob/. Also use when creating or fixing redrob agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring redrob itself.",
    location: AbsolutePath.make("/builtin/customize-redrob.md"),
    content: CustomizeRedrobContent,
  }),
  // K-3. The keywords are the words a request for this work actually contains; the URL globs
  // are the web editors where a document is the thing on screen.
  SkillV2.Info.make({
    name: "documents",
    description:
      "Use when reading or writing a Word, Excel, PowerPoint or PDF file in code mode: the `docx`, `xlsx`, `pptx` and `pdf` globals, their exact read and write shapes, and which parts of a PDF genuinely cannot be read. Use it before writing any program that touches a document file. Do not use for plain text, markdown, CSV or JSON, which need no document toolchain.",
    location: AbsolutePath.make("/builtin/document-toolchain.md"),
    autoInject: SkillV2.AutoInject.make({
      keywords: ["docx", "xlsx", "pptx", "pdf", "spreadsheet", "powerpoint", "word document", "slide deck"],
      url: [
        "docs.google.com/document/**",
        "docs.google.com/spreadsheets/**",
        "docs.google.com/presentation/**",
        "*.officeapps.live.com/**",
      ],
    }),
    content: DocumentToolchainContent,
  }),
  // K-5. No `autoInject`: writing a skill is something a person asks for by name, and a skill
  // that armed on the word "skill" would be in the prompt of every session that mentions one.
  SkillV2.Info.make({
    name: "skill-writer",
    description:
      "Use when creating a new redrob skill, or fixing one that does not load: where SKILL.md must sit for the loader to find it, every frontmatter key the loader actually reads, the auto-arming block, and the template to copy. Do not use for agents, commands or plugins, which are different files with different shapes.",
    location: AbsolutePath.make("/builtin/skill-writer.md"),
    content: SkillWriterContent,
  }),
]

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      for (const skill of BuiltinSkills) {
        draft.source(SkillV2.EmbeddedSource.make({ type: "embedded", skill }))
      }
    })
  }),
})
