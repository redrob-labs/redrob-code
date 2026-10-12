/**
 * What a change looks like, measured from its unified diff alone, with no model involved.
 *
 * The same measurement runs on every candidate and on the repository's own recent human commits, which
 * is what lets a candidate be placed in the repo's distribution (quality.ts).
 */

export type FileStats = {
  path: string
  added: string[]
  removed: string[]
  isTest: boolean
  isNew: boolean
  isDeleted: boolean
}

export type DiffStats = {
  files: FileStats[]
  added: number
  removed: number
  /** Added lines in test files. */
  testAdded: number
  /** Added code lines (not tests, not blank, not comments). */
  codeAdded: number
  /** Normalised 4-line windows added more than once, a cheap signal of copy-paste. */
  duplicateWindows: number
  /** Deepest indentation level among added code lines, in steps of the file's indent unit. */
  maxNesting: number
  /** Added lines longer than 120 characters. */
  longLines: number
  /** TODO/FIXME/XXX/HACK, debug prints and disabled lint rules introduced by the change. */
  debris: number
}

const TEST_PATH = [
  /(^|\/)(test|tests|__tests__|spec|specs)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /_test\.(py|go|rs|rb)$/i,
  /Tests?\.(java|kt|cs|swift)$/,
]

export function isTestPath(file: string) {
  return TEST_PATH.some((pattern) => pattern.test(file.replaceAll("\\", "/")))
}

const COMMENT = /^\s*(\/\/|#|\*|\/\*|--|;)/
const DEBRIS = [
  /\b(TODO|FIXME|XXX|HACK)\b/,
  /\bconsole\.(log|debug)\(/,
  /\bdebugger\b/,
  /^\s*print\(/,
  /\bfmt\.Println\(/,
  /eslint-disable|@ts-ignore|@ts-nocheck|# type: ignore|noqa|oxlint-disable/,
]

export function parseDiff(diff: string): FileStats[] {
  const files: FileStats[] = []
  let current: FileStats | null = null
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = / b\/(.+)$/.exec(line)
      const file = match?.[1] ?? ""
      current = { path: file, added: [], removed: [], isTest: isTestPath(file), isNew: false, isDeleted: false }
      files.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith("new file mode")) current.isNew = true
    else if (line.startsWith("deleted file mode")) current.isDeleted = true
    else if (line.startsWith("+++") || line.startsWith("---")) continue
    else if (line.startsWith("+")) current.added.push(line.slice(1))
    else if (line.startsWith("-")) current.removed.push(line.slice(1))
  }
  return files
}

function indentUnit(lines: string[]) {
  const widths = lines.map((line) => /^( +)\S/.exec(line)?.[1]?.length ?? 0).filter((width) => width > 0)
  if (widths.length === 0) return 2
  return Math.max(2, Math.min(...widths))
}

export function measure(diff: string): DiffStats {
  const files = parseDiff(diff)
  let added = 0
  let removed = 0
  let testAdded = 0
  let codeAdded = 0
  let maxNesting = 0
  let longLines = 0
  let debris = 0
  const windows = new Map<string, number>()

  for (const file of files) {
    added += file.added.length
    removed += file.removed.length
    if (file.isTest) {
      testAdded += file.added.length
      continue
    }
    const unit = indentUnit(file.added)
    const code = file.added.filter((line) => line.trim() !== "" && !COMMENT.test(line))
    codeAdded += code.length
    for (const line of file.added) {
      if (line.length > 120) longLines++
      if (DEBRIS.some((pattern) => pattern.test(line))) debris++
    }
    for (const line of code) {
      const expanded = line.replace(/\t/g, " ".repeat(unit))
      const depth = Math.floor((/^ */.exec(expanded)?.[0].length ?? 0) / unit)
      maxNesting = Math.max(maxNesting, depth)
    }
    const normalized = code.map((line) => line.trim().replace(/\s+/g, " ")).filter((line) => line.length > 3)
    for (let i = 0; i + 4 <= normalized.length; i++) {
      const window = normalized.slice(i, i + 4).join("\n")
      windows.set(window, (windows.get(window) ?? 0) + 1)
    }
  }
  const duplicateWindows = [...windows.values()].filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0)
  return { files, added, removed, testAdded, codeAdded, duplicateWindows, maxNesting, longLines, debris }
}
