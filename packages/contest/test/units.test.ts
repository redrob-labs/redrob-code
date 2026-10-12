import { describe, expect, test } from "bun:test"
import { chooseBench, eligible, vendorOf, type Candidate } from "../src/bench"
import { compare, countWarnings } from "../src/checks"
import { isTestPath, measure } from "../src/diffstats"
import { inspect } from "../src/guard"
import { percentile, score } from "../src/quality"
import { redact } from "../src/redact"
import { parseReview, reviewPrompt } from "../src/review"
import { combine, consensus, rank, type Vote } from "../src/tournament"

const model = (id: string, providerID = "redrob"): Candidate => ({
  id,
  providerID,
  tools: true,
  vendor: vendorOf({ id, providerID }),
})

describe("bench", () => {
  test("vendor comes from the slug prefix or the bare id", () => {
    expect(vendorOf({ providerID: "redrob", id: "claude-opus-5" })).toBe("anthropic")
    expect(vendorOf({ providerID: "redrob", id: "gpt-5.6-sol" })).toBe("openai")
    expect(vendorOf({ providerID: "redrob", id: "google/gemini-3.8-flash" })).toBe("google")
    expect(vendorOf({ providerID: "redrob", id: "qwen/qwen3-coder" })).toBe("qwen")
    expect(vendorOf({ providerID: "acme", id: "coder" })).toBe("acme")
  })

  test("routers, data-sharing models and non-chat models never compete", () => {
    expect(eligible({ providerID: "redrob", id: "auto" })).toBe(false)
    expect(eligible({ providerID: "redrob", id: "claude-fable-5" })).toBe(false)
    expect(eligible({ providerID: "redrob", id: "openai/text-embedding-3" })).toBe(false)
    expect(eligible({ providerID: "redrob", id: "x", tools: false })).toBe(false)
    expect(eligible({ providerID: "redrob", id: "claude-sonnet-5" })).toBe(true)
  })

  test("builders come from different companies and reviewers from the rest", () => {
    const pool = [
      "claude-opus-5",
      "claude-sonnet-5",
      "gpt-5.6-sol",
      "google/gemini-3.8-flash",
      "qwen/qwen3-coder",
      "deepseek/deepseek-v4-pro",
    ].map((id) => model(id))
    const bench = chooseBench(pool, { builders: 3, reviewers: 2, random: () => 0.5 })
    expect(new Set(bench.builders.map((b) => b.vendor)).size).toBe(3)
    expect(bench.neutral).toBe(true)
    for (const reviewer of bench.reviewers) expect(bench.builders.map((b) => b.vendor)).not.toContain(reviewer.vendor)
  })

  test("with too few companies it fills the slots and says it is not neutral", () => {
    const bench = chooseBench([model("claude-opus-5"), model("claude-sonnet-5"), model("gpt-5.6-sol")], {
      builders: 3,
      reviewers: 2,
      random: () => 0,
    })
    expect(bench.builders.length).toBe(3)
    expect(bench.neutral).toBe(false)
    expect(bench.notes.join(" ")).toContain("share a company")
  })

  test("an explicit pick that is unavailable is reported, not silently swapped", () => {
    const bench = chooseBench([model("gpt-5.6-sol")], { builders: 1, reviewers: 0, prefer: ["redrob/claude-opus-5"] })
    expect(bench.notes[0]).toContain("not available")
    expect(bench.builders[0]!.id).toBe("gpt-5.6-sol")
  })
})

const diff = (path: string, added: string[], options: { isNew?: boolean } = {}) =>
  [
    `diff --git a/${path} b/${path}`,
    ...(options.isNew ? ["new file mode 100644"] : []),
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    ...added.map((line) => `+${line}`),
  ].join("\n")

describe("diff measurement and quality", () => {
  test("classifies test files across ecosystems", () => {
    for (const file of [
      "src/a.test.ts",
      "tests/test_math.py",
      "pkg/math_test.go",
      "__tests__/x.js",
      "src/MathTests.cs",
    ])
      expect(isTestPath(file)).toBe(true)
    expect(isTestPath("src/testing-utils.ts")).toBe(false)
  })

  test("a clean, tested change scores higher than a messy untested one", () => {
    const clean = measure(
      [
        diff("src/sum.ts", ["export function sum(a: number, b: number) {", "  return a + b", "}"]),
        diff("src/sum.test.ts", ["test('sum', () => {})"], { isNew: true }),
      ].join("\n"),
    )
    const block = [
      "if (a) {",
      "  if (b) {",
      "    if (c) {",
      "      if (d) {",
      "        if (e) {",
      "          console.log('debug')",
      "        }",
      "      }",
      "    }",
      "  }",
      "}",
    ]
    const messy = measure(diff("src/sum.ts", [...block, ...block, "// TODO: fix", "// eslint-disable-next-line"]))
    expect(messy.duplicateWindows).toBeGreaterThan(0)
    expect(messy.maxNesting).toBe(5)
    const good = score(clean)
    const bad = score(messy)
    expect(good.score).toBe(100)
    expect(bad.score).toBeLessThan(80)
    expect(bad.components.map((c) => c.name)).toEqual(
      expect.arrayContaining(["debris", "duplication", "nesting", "tests"]),
    )
  })

  test("a regressed check costs more than any style issue", () => {
    const stats = measure(diff("src/a.ts", ["export const a = 1"]))
    expect(score(stats, { checks: { regressions: 1, fixes: 0, newWarnings: 0 } }).score).toBeLessThanOrEqual(65)
  })

  test("percentile places a value in the repo's distribution", () => {
    expect(percentile(90, [50, 60, 70, 80, 90, 100])).toBe(83.3)
    expect(percentile(100, [100, 100])).toBe(100)
    expect(percentile(1, [])).toBeNull()
  })

  test("check deltas are measured against the base commit", () => {
    const base = [
      { name: "test", passed: true, warnings: 1, durationMs: 1, output: "", timedOut: false },
      { name: "lint", passed: false, warnings: 3, durationMs: 1, output: "", timedOut: false },
    ]
    const after = [
      { name: "test", passed: false, warnings: 4, durationMs: 1, output: "", timedOut: false },
      { name: "lint", passed: true, warnings: 2, durationMs: 1, output: "", timedOut: false },
    ]
    expect(compare(base, after)).toEqual({ regressions: 1, fixes: 1, newWarnings: 3 })
    expect(countWarnings("a\nwarning: x\nFound 0 warnings\n⚠ y")).toBe(2)
  })
})

describe("test-gaming guard", () => {
  test("flags edited, skipped and special-cased tests, and test config", () => {
    const stats = measure(
      [
        diff("src/a.test.ts", ["it.skip('works', () => {})"]),
        diff("src/a.ts", ["if (process.env.NODE_ENV === 'test') return 42"]),
        diff("tests/new.test.ts", ["test('new', () => {})"], { isNew: true }),
      ].join("\n"),
    )
    const flags = inspect(
      [
        { path: "src/a.test.ts", status: "M" },
        { path: "src/a.ts", status: "M" },
        { path: "tests/new.test.ts", status: "A" },
        { path: "vitest.config.ts", status: "M" },
        { path: "src/old.test.ts", status: "D" },
      ],
      stats.files,
    )
    expect(flags.map((flag) => flag.kind).sort()).toEqual([
      "deleted-test",
      "edited-test",
      "skip",
      "test-config",
      "test-env-branch",
    ])
  })

  test("adding a new test file is not a flag", () => {
    const stats = measure(diff("tests/new.test.ts", ["test('new', () => {})"], { isNew: true }))
    expect(inspect([{ path: "tests/new.test.ts", status: "A" }], stats.files)).toEqual([])
  })
})

describe("tournament", () => {
  const vote = (first: string, second: string, reviewer: string, winner: string | "tie"): Vote => ({
    first,
    second,
    reviewer,
    winner,
    confidence: 0.8,
    reasons: [],
  })

  test("a vote counts only when the reviewer agrees with itself across both orders", () => {
    const votes = [
      vote("A", "B", "r1", "A"),
      vote("B", "A", "r1", "A"),
      // r2 always prefers whichever came first: position bias, so a tie
      vote("A", "B", "r2", "A"),
      vote("B", "A", "r2", "B"),
    ]
    const { outcomes, standings } = combine(["A", "B"], votes, ["r1", "r2"])
    expect(outcomes[0]!.verdicts).toEqual([
      { reviewer: "r1", winner: "A" },
      { reviewer: "r2", winner: "tie" },
    ])
    expect(outcomes[0]!.winner).toBe("A")
    expect(standings.find((s) => s.slot === "A")!.wins).toBe(1)
  })

  test("ranking falls back to the Quality Score, and consensus is the share of pairs won", () => {
    const votes = [
      vote("A", "B", "r", "tie"),
      vote("B", "A", "r", "tie"),
      vote("A", "C", "r", "A"),
      vote("C", "A", "r", "A"),
      vote("B", "C", "r", "B"),
      vote("C", "B", "r", "B"),
    ]
    const { standings } = combine(["A", "B", "C"], votes, ["r"])
    const ranked = rank(standings, { A: 70, B: 90, C: 50 })
    expect(ranked.map((s) => s.slot)).toEqual(["B", "A", "C"])
    expect(consensus(ranked[0], 3)).toBe(0.5)
  })
})

describe("review prompt and parsing", () => {
  test("parses a verdict from fenced or surrounded JSON", () => {
    expect(parseReview('Sure.\n```json\n{"winner":"second","confidence":0.9,"reasons":["simpler"]}\n```')!.winner).toBe(
      "second",
    )
    expect(parseReview('{"winner":"first","acceptTestChanges":{"first":false}}')!.acceptTestChanges).toEqual({
      first: false,
      second: true,
    })
    expect(parseReview("I prefer the first one")).toBeNull()
  })

  test("the prompt shows evidence by position, never by slot or model", () => {
    const evidence = { diff: "+a", checks: [], crossTests: null, quality: { score: 90, components: [] }, flags: [] }
    const prompt = reviewPrompt({ task: "Add sum", standard: null, first: evidence, second: evidence })
    expect(prompt).toContain("## First candidate")
    expect(prompt).not.toMatch(/\bslot\b|candidate [ABC]\b/)
  })

  test("names are redacted from what reviewers and choosers see", () => {
    expect(redact("I am Claude by Anthropic; GPT-5.6 would differ, as would Qwen3-coder.")).toBe(
      "I am [model] by [model]; [model] would differ, as would [model].",
    )
  })
})
