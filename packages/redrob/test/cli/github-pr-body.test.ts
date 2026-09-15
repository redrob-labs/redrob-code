import { test, expect, describe } from "bun:test"
import { pullRequestBody } from "../../src/cli/cmd/github"
import { ShellPrompt } from "../../src/tool/shell/prompt"

describe("pullRequestBody", () => {
  const trailer = "Closes #12"

  test("keeps the agent's report and appends the trailer", () => {
    const body = pullRequestBody("Fixed the parser.", trailer)
    expect(body).toBe("Fixed the parser.\n\nCloses #12")
  })

  test("trims the report so trailing model whitespace does not pad the body", () => {
    expect(pullRequestBody("  Fixed the parser.\n\n  ", trailer)).toBe("Fixed the parser.\n\nCloses #12")
  })

  // The defect this guards: the body used to be `${response}\n\n${trailer}`, so a
  // turn that produced no text opened a PR whose whole description was "Closes #12".
  // A reviewer could not tell what the PR did, and nothing reported that the
  // description was missing rather than merely terse.
  for (const [name, report] of [
    ["empty", ""],
    ["whitespace only", "   \n\t\n  "],
  ] as const) {
    test(`says so when the report is ${name}, rather than shipping a bare cross-reference`, () => {
      const body = pullRequestBody(report, trailer)
      expect(body).not.toBe(`\n\n${trailer}`)
      expect(body).toContain("## Summary")
      expect(body).toContain("did not produce a summary")
      // The trailer must survive: GitHub needs it to link and close the issue.
      expect(body).toContain(trailer)
    })
  }

  test("never returns a body whose only content is the trailer", () => {
    for (const report of ["", " ", "\n", "\t"]) {
      const withoutTrailer = pullRequestBody(report, trailer).replace(trailer, "").trim()
      expect(withoutTrailer.length).toBeGreaterThan(0)
    }
  })
})

describe("shell prompt PR scaffold", () => {
  // The bash scaffold used to open `<<'EOF'` and never close it, and the prompt
  // template had dropped the placeholders that carry it — so the one example the
  // model was given was both unreachable and, on the default shell, malformed.
  const limits = { maxOutputBytes: 30000 } as unknown as ShellPrompt.Limits
  const describeFor = (name: string, platform: NodeJS.Platform) =>
    JSON.stringify(ShellPrompt.render(name, platform, limits, 120000))

  test("bash: the create-PR heredoc is closed", () => {
    const rendered = describeFor("bash", "linux")
    const opens = (rendered.match(/<<'EOF'/g) ?? []).length
    expect(opens).toBeGreaterThan(0)
    const closes = (rendered.match(/\\nEOF\\n/g) ?? []).length
    expect(closes).toBe(opens)
  })

  test("the scaffold reaches the model instead of rendering into nothing", () => {
    for (const [name, platform] of [
      ["bash", "linux"],
      ["powershell", "win32"],
      ["cmd", "win32"],
    ] as const) {
      const rendered = describeFor(name, platform)
      expect(rendered).not.toContain("${createPrExample}")
      expect(rendered).not.toContain("${createPrInstruction}")
      expect(rendered).toContain("## Summary")
      expect(rendered).toContain("## Testing")
    }
  })
})
