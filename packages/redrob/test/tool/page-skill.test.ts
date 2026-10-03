/**
 * PA-9's page-control skill, held to the `page` surface it describes.
 *
 * Checked BOTH ways, for the same reason K-3's document is: a skill that names a call which
 * does not exist produces an agent that calls it and fails, and a call the document never
 * mentions is a capability the agent will not reach for. The real set comes from the bound
 * tool namespace, not from a list retyped here -- a list retyped here would agree with the
 * document while both disagreed with the code.
 */
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SkillPlugin } from "@redrob-code/core/plugin/skill"
import { SkillV2 } from "@redrob-code/core/skill"
import { domainTools, unavailableChannel, unavailablePage } from "@/tool/domain"

const DOC = SkillPlugin.PageControlContent

/** Every `page.<method>` the document mentions, deduplicated. */
const mentioned = new Set([...DOC.matchAll(/\bpage\.([A-Za-z]+)\b/g)].map((match) => `page.${match[1]}`))

/** Every `page.<method>` the engine actually binds. */
const real = new Set(
  Object.keys(
    domainTools({ page: unavailablePage("test"), channel: unavailableChannel("test") }).page ?? {},
  ).map((method) => `page.${method}`),
)

describe("page-control skill", () => {
  test("names every page call that exists", () => {
    expect(real.size).toBeGreaterThan(0)
    for (const call of real) expect(mentioned).toContain(call)
  })

  test("names no page call that does not exist", () => {
    for (const call of mentioned) expect(real).toContain(call)
  })

  test("the count it claims is the count there is", () => {
    // The document opens with "Six calls. There is no seventh". If the surface grows, that
    // sentence becomes a lie and this is where it is caught.
    expect(real.size).toBe(6)
    expect(DOC).toContain("Six calls")
  })

  test("it is shipped, and armed by keyword rather than by URL", () => {
    const info = SkillPlugin.BuiltinSkills.find((skill) => skill.name === "page-control")
    expect(info).toBeDefined()
    expect(info?.content).toBe(DOC)
    // Decoded through the real schema, the way the loader does: `Info.make` does not run the
    // decoder, so a field in a shape the schema rejects would otherwise reach a session.
    const decoded = Schema.decodeUnknownSync(SkillV2.Info)(JSON.parse(JSON.stringify(info)))
    expect(decoded.name).toBe("page-control")
    expect(decoded.autoInject?.keywords?.length ?? 0).toBeGreaterThan(0)
    // No URL globs on purpose: a page skill armed by URL would be in the prompt of every
    // session on any page, which is every session with a browser attached.
    expect(info?.autoInject?.url ?? []).toEqual([])
  })

  test("it says a refusal is about the session and an empty result about the page", () => {
    // The distinction the engine's tagged Value union exists to preserve. A document that
    // blurred it would teach the agent to read "nothing matched" as "no browser".
    expect(DOC).toContain("DomainUnavailableError")
    expect(DOC).toContain("different from a refusal")
  })
})
