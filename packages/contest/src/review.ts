import type { Flag } from "./guard"
import type { Component } from "./quality"

/**
 * What a reviewer is shown, and how its answer is read.
 *
 * The reviewer gets two de-identified candidates labelled by position ("first", "second"), never by
 * slot, so the label cannot carry over between the two orders of the same pair.
 */

export type Evidence = {
  diff: string
  checks: { name: string; passed: boolean; baselinePassed: boolean | null }[]
  crossTests: { passed: number; total: number } | null
  quality: { score: number; components: Component[] }
  flags: Flag[]
}

export type ReviewRequest = { task: string; standard: string | null; first: Evidence; second: Evidence }

const MAX_DIFF = 60_000

function describe(label: string, evidence: Evidence) {
  const checks = evidence.checks.length
    ? evidence.checks
        .map(
          (check) =>
            `- ${check.name}: ${check.passed ? "pass" : "FAIL"}${check.baselinePassed === false ? " (already failing before the change)" : ""}`,
        )
        .join("\n")
    : "- no checks found in this repository"
  const cross = evidence.crossTests
    ? `${evidence.crossTests.passed}/${evidence.crossTests.total} of the OTHER builders' reproduction tests pass`
    : "no cross-tests could be run"
  const flags = evidence.flags.length
    ? evidence.flags.map((flag) => `- ${flag.file}: ${flag.detail}`).join("\n")
    : "- none"
  const quality = evidence.quality.components.length
    ? evidence.quality.components
        .map((component) => `- ${component.name}: −${component.penalty} (${component.detail})`)
        .join("\n")
    : "- no penalties"
  const diff = evidence.diff.length > MAX_DIFF ? `${evidence.diff.slice(0, MAX_DIFF)}\n[diff truncated]` : evidence.diff
  return [
    `## ${label} candidate`,
    `Checks:\n${checks}`,
    `Cross-tests: ${cross}`,
    `Automatic quality score: ${evidence.quality.score}/100\n${quality}`,
    `Test-integrity flags:\n${flags}`,
    "Diff:",
    "```diff",
    diff || "(no changes)",
    "```",
  ].join("\n\n")
}

export function reviewPrompt(request: ReviewRequest) {
  return [
    "You are a strict senior reviewer judging two candidate changes for the same task in the same repository.",
    "You do not know who or what wrote either candidate. Judge only the evidence below.",
    "Do not open, read or edit any file; everything you need is in this message.",
    "",
    "Judge, in this order: (1) does it actually solve the task, (2) correctness and safety,",
    "(3) whether a maintainer of THIS repository would merge it as is — following the house standard and",
    "existing conventions, no unnecessary changes, clear names, tests that would catch a regression,",
    "(4) simplicity. Do not reward length. A failing check or an unjustified test-integrity flag is a",
    "strong reason to prefer the other candidate.",
    "",
    `# Task\n\n${request.task}`,
    request.standard ? `# House standard\n\n${request.standard}` : "",
    describe("First", request.first),
    describe("Second", request.second),
    "",
    "Reply with ONLY a JSON object, no prose before or after it:",
    '{"winner": "first" | "second" | "tie", "confidence": 0.0-1.0, "reasons": ["..."],',
    ' "acceptTestChanges": {"first": true|false, "second": true|false}, "risks": ["..."]}',
    '"acceptTestChanges" is true only when that candidate has test-integrity flags AND the task genuinely',
    "required those test changes; with no flags, answer true.",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

export type ReviewAnswer = {
  winner: "first" | "second" | "tie"
  confidence: number
  reasons: string[]
  acceptTestChanges: { first: boolean; second: boolean }
  risks: string[]
}

/** Reads the reviewer's JSON, tolerating a fenced block or prose around it. Null when there is none. */
export function parseReview(text: string): ReviewAnswer | null {
  const candidates = [...text.matchAll(/\{[\s\S]*\}/g)].map((match) => match[0])
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]
  for (const raw of [fenced, ...candidates, text].filter((value): value is string => Boolean(value))) {
    try {
      const value = JSON.parse(raw) as Partial<ReviewAnswer>
      if (value.winner !== "first" && value.winner !== "second" && value.winner !== "tie") continue
      const accept = (value.acceptTestChanges ?? {}) as Partial<ReviewAnswer["acceptTestChanges"]>
      return {
        winner: value.winner,
        confidence: typeof value.confidence === "number" ? Math.max(0, Math.min(1, value.confidence)) : 0.5,
        reasons: Array.isArray(value.reasons) ? value.reasons.map(String).slice(0, 8) : [],
        acceptTestChanges: { first: accept.first !== false, second: accept.second !== false },
        risks: Array.isArray(value.risks) ? value.risks.map(String).slice(0, 8) : [],
      }
    } catch {}
  }
  return null
}

export function builderPrompt(input: { task: string; standard: string | null }) {
  return [
    input.task,
    "",
    "---",
    "How to work on this task:",
    "- Make the smallest complete change that solves it, in the style this repository already uses.",
    "- Add or extend a test that FAILS without your change and PASSES with it (a reproduction test). Put it",
    "  in a NEW test file where the project's test runner will find it.",
    "- Do not edit, delete, skip or weaken existing tests, snapshots or test configuration unless the task",
    "  explicitly asks for it. Do not special-case the test environment.",
    "- Run the project's checks if you can, and fix what you broke.",
    "- Do not name yourself, your model or your company anywhere: not in code, comments or messages.",
    "- When you are done, stop. Do not commit; the change is collected from the working tree.",
    input.standard ? `\nThe house standard for this repository:\n\n${input.standard}` : "",
  ].join("\n")
}
