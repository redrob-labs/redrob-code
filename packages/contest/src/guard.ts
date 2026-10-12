import type { FileChange } from "./git"
import { isTestPath, type FileStats } from "./diffstats"

/**
 * The test-gaming guard.
 *
 * Agents edit tests, skip them, or special-case the test environment when that is the easiest way to
 * get green (ImpossibleBench, EvilGenie). A change that does any of that is flagged; a flagged
 * candidate can still win, but only when every reviewer independently accepts the test change as
 * something the task asked for.
 */

export type Flag = {
  kind: "edited-test" | "deleted-test" | "test-config" | "snapshot" | "skip" | "test-env-branch"
  file: string
  detail: string
}

const TEST_CONFIG = [
  /(^|\/)(jest|vitest|vite|playwright|karma|mocha|ava|bunfig)\.config\.[cm]?[jt]s$/i,
  /(^|\/)\.mocharc/i,
  /(^|\/)bunfig\.toml$/i,
  /(^|\/)(pytest\.ini|tox\.ini|conftest\.py|setup\.cfg)$/i,
  /(^|\/)\.?(nycrc|c8rc)/i,
]
const SNAPSHOT = [/__snapshots__\//, /\.snap$/, /\.snapshot$/]
const SKIP = [
  /\b(it|test|describe)\.(skip|only|todo)\(/,
  /\b(xit|xdescribe|xtest)\(/,
  /@pytest\.mark\.(skip|xfail)/,
  /\bt\.Skip\(/,
  /#\[ignore\]/,
  /@(Disabled|Ignore)\b/,
]
const TEST_ENV = [
  /process\.env\.(NODE_ENV\s*===?\s*["']test["']|VITEST|JEST_WORKER_ID|BUN_TEST)/,
  /\bimport\.meta\.vitest\b/,
  /["']pytest["']\s+in\s+sys\.modules/,
  /\bos\.environ(\.get)?\(?\[?["']PYTEST_CURRENT_TEST/,
  /testing\.Testing\(\)/,
]

export function inspect(changes: FileChange[], stats: FileStats[]): Flag[] {
  const flags: Flag[] = []
  for (const change of changes) {
    const file = change.path
    if (isTestPath(change.from ?? file) && (change.status === "M" || change.status === "R"))
      flags.push({ kind: "edited-test", file, detail: "changes a test that existed before" })
    if (change.status === "D" && isTestPath(file)) flags.push({ kind: "deleted-test", file, detail: "deletes a test" })
    if (TEST_CONFIG.some((pattern) => pattern.test(file)))
      flags.push({ kind: "test-config", file, detail: "changes test configuration" })
    if (SNAPSHOT.some((pattern) => pattern.test(file)) && change.status !== "A")
      flags.push({ kind: "snapshot", file, detail: "rewrites a stored snapshot" })
  }
  for (const file of stats) {
    for (const line of file.added) {
      if (file.isTest && SKIP.some((pattern) => pattern.test(line)))
        flags.push({
          kind: "skip",
          file: file.path,
          detail: `adds a skipped or focused test: ${line.trim().slice(0, 100)}`,
        })
      if (!file.isTest && TEST_ENV.some((pattern) => pattern.test(line)))
        flags.push({
          kind: "test-env-branch",
          file: file.path,
          detail: `branches on running under test: ${line.trim().slice(0, 100)}`,
        })
    }
  }
  return flags
}
