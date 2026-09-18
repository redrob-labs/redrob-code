import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The answer-options marker.
 *
 * The app can already turn a suggestion into a filled composer, in two places built for two specific
 * moments. What it could not do was let the MODEL offer choices at a moment of its own choosing, so a
 * question with three sensible answers arrived as prose and the user retyped one by hand.
 *
 * What these guard is the part that is easy to get wrong later: the instruction has to reach EVERY
 * provider, and it has to reach them from one place. There are fourteen provider prompt files and the
 * assembly picks exactly one of them per model, so an instruction copied into the files is an instruction
 * that will be true of some models and not others as soon as anyone edits one file.
 */
const prompt = readFileSync(join(import.meta.dir, "..", "..", "src", "session", "prompt.ts"), "utf8")

describe("answer options", () => {
  it("states the exact marker form, since the app parses it literally", () => {
    expect(prompt).toContain("[OPTIONS: first choice | second choice | third choice]")
  })

  it("is appended to the assembled system prompt, not to one provider's file", () => {
    // The assembly is the single place every provider passes through.
    expect(prompt).toContain("ANSWER_OPTIONS_PROMPT,")
    const files = ["anthropic", "gpt", "gemini", "kimi", "default", "beast", "codex", "meta", "trinity"]
    for (const name of files) {
      const body = readFileSync(join(import.meta.dir, "..", "..", "src", "session", "prompt", `${name}.txt`), "utf8")
      expect(body).not.toContain("[OPTIONS:")
    }
  })

  it("keeps the line optional and last, which is what makes it free when unused", () => {
    expect(prompt).toContain("MAY end the message with a single line")
    expect(prompt).toContain("must be the LAST line")
    expect(prompt).toContain("still make sense with the line removed")
  })

  it("refuses the two cases where options are the wrong shape", () => {
    // A free-text answer and a destructive confirmation both need the user's own words.
    expect(prompt).toContain("needs a real answer in the user's own words")
    expect(prompt).toContain("confirm a destructive action")
  })
})
