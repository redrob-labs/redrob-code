/**
 * Controlled damage to a known-good patch, for checking the judge without human labels.
 *
 * Each perturbation takes a human patch that the project merged and makes it measurably worse in one
 * way. A trustworthy judge must prefer the original over every one of them, in both presentation
 * orders, and must call an untouched copy a tie (CertJudge's bug-monotonicity and identity properties).
 * Every function is pure: diff text in, diff text out, or null when the patch has nothing to damage.
 */

export type Perturbation = { kind: "bug" | "duplicate" | "debris" | "test-skip"; diff: string }

type Hunk = { file: string; start: number; end: number }

function addedCodeLines(lines: string[]) {
  const result: { index: number; file: string; isTest: boolean }[] = []
  let file = ""
  let isTest = false
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("diff --git ")) {
      file = / b\/(.+)$/.exec(line)?.[1] ?? ""
      isTest = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.|(^|\/)test_|_test\./i.test(file)
      continue
    }
    if (line.startsWith("+") && !line.startsWith("+++") && line.slice(1).trim() !== "")
      result.push({ index, file, isTest })
  }
  return result
}

const SWAPS: [RegExp, string][] = [
  [/ - /, " + "],
  [/ \+ (?!\+)/, " - "],
  [/ \* /, " / "],
  [/ \/ /, " * "],
  [/ < /, " <= "],
  [/ > /, " >= "],
  [/ <= /, " < "],
  [/ >= /, " > "],
  [/ === /, " !== "],
  [/ !== /, " === "],
  [/ == /, " != "],
  [/ != /, " == "],
  [/\btrue\b/, "false"],
  [/\bfalse\b/, "true"],
  [/ && /, " || "],
  [/ \|\| /, " && "],
]

/** Flips one operator or literal in an added, non-test line: a plausible-looking wrong answer. */
export function injectBug(diff: string): string | null {
  const lines = diff.split("\n")
  for (const target of addedCodeLines(lines).filter((line) => !line.isTest)) {
    const line = lines[target.index]!
    for (const [pattern, replacement] of SWAPS) {
      if (pattern.test(line.slice(1))) {
        lines[target.index] = "+" + line.slice(1).replace(pattern, replacement)
        return lines.join("\n")
      }
    }
  }
  return null
}

/** Repeats the first run of added code lines, the copy-paste a reviewer should reject. */
export function duplicateBlock(diff: string): string | null {
  const lines = diff.split("\n")
  const code = addedCodeLines(lines).filter((line) => !line.isTest)
  if (code.length < 2) return null
  const run: number[] = [code[0]!.index]
  for (const entry of code.slice(1)) {
    if (entry.index !== run[run.length - 1]! + 1 || run.length >= 6) break
    run.push(entry.index)
  }
  if (run.length < 2) return null
  const copy = run.map((index) => lines[index]!)
  lines.splice(run[run.length - 1]! + 1, 0, ...copy)
  return fixHunkHeaders(lines.join("\n"))
}

/** Adds a debug print and a TODO after the first added code line. */
export function addDebris(diff: string): string | null {
  const lines = diff.split("\n")
  const first = addedCodeLines(lines).find((line) => !line.isTest)
  if (!first) return null
  const indent = /^\+(\s*)/.exec(lines[first.index]!)?.[1] ?? ""
  const python = first.file.endsWith(".py")
  const debris = python
    ? [`+${indent}print("debug")  # TODO: remove`]
    : [`+${indent}console.log("debug") // TODO: remove`]
  lines.splice(first.index + 1, 0, ...debris)
  return fixHunkHeaders(lines.join("\n"))
}

/** Turns the patch's first added test into a skipped one: green by not running. */
export function skipTest(diff: string): string | null {
  const lines = diff.split("\n")
  for (const target of addedCodeLines(lines).filter((line) => line.isTest)) {
    const line = lines[target.index]!
    const replaced = line
      .replace(/\b(it|test)\(/, "$1.skip(")
      .replace(/^(\+\s*)def test_/, "$1@pytest.mark.skip\n+$1def test_")
    if (replaced !== line) {
      lines[target.index] = replaced
      return fixHunkHeaders(lines.join("\n"))
    }
  }
  return null
}

export function perturbations(diff: string): Perturbation[] {
  const result: Perturbation[] = []
  const bug = injectBug(diff)
  if (bug) result.push({ kind: "bug", diff: bug })
  const duplicate = duplicateBlock(diff)
  if (duplicate) result.push({ kind: "duplicate", diff: duplicate })
  const debris = addDebris(diff)
  if (debris) result.push({ kind: "debris", diff: debris })
  const skip = skipTest(diff)
  if (skip) result.push({ kind: "test-skip", diff: skip })
  return result
}

/** Recomputes `@@ -a,b +c,d @@` counts after lines were added, so the diff still reads as a diff. */
function fixHunkHeaders(diff: string) {
  const lines = diff.split("\n")
  const hunks: Hunk[] = []
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("@@")) {
      if (hunks.length) hunks[hunks.length - 1]!.end = index
      hunks.push({ file: "", start: index, end: lines.length })
    } else if (line.startsWith("diff --git ") && hunks.length && hunks[hunks.length - 1]!.end === lines.length) {
      hunks[hunks.length - 1]!.end = index
    }
  }
  for (const hunk of hunks) {
    const body = lines.slice(hunk.start + 1, hunk.end)
    const old = body.filter((line) => line.startsWith(" ") || (line.startsWith("-") && !line.startsWith("---"))).length
    const next = body.filter((line) => line.startsWith(" ") || (line.startsWith("+") && !line.startsWith("+++"))).length
    lines[hunk.start] = lines[hunk.start]!.replace(
      /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/,
      `@@ -$1,${old} +$2,${next} @@`,
    )
  }
  return lines.join("\n")
}
