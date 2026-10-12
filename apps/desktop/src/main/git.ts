import { execFile } from "node:child_process"
import type { GitChanges } from "../shared/bridge"

/**
 * What changed in a project folder, read from git directly.
 *
 * The working tree is the truth the person will commit, whatever made the change -- the agent, the
 * terminal, or their editor -- so the changes view reads it rather than reconstructing it from tool
 * calls. Read-only: nothing here writes to the repository.
 */

const MAX_DIFF = 2_000_000

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd, maxBuffer: MAX_DIFF * 2, windowsHide: true, encoding: "utf8" },
      (error, stdout) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 0
        resolve({ code: error ? code || 1 : 0, stdout: stdout ?? "" })
      },
    )
  })
}

/** Parses `git status --porcelain=v1 -z`. Exported for the tests. */
export function parseStatus(output: string): GitChanges["files"] {
  const entries = output.split("\0")
  const files: GitChanges["files"] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry || entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    const file = entry.slice(3)
    if (x === "R" || x === "C") {
      files.push({ path: file, status: "renamed" })
      i++ // the original path follows as its own entry
      continue
    }
    if (x === "?" && y === "?") files.push({ path: file, status: "untracked" })
    else if (x === "A" || y === "A") files.push({ path: file, status: "added" })
    else if (x === "D" || y === "D") files.push({ path: file, status: "deleted" })
    else files.push({ path: file, status: "modified" })
  }
  return files
}

export async function gitChanges(directory: string): Promise<GitChanges> {
  const inside = await git(directory, ["rev-parse", "--is-inside-work-tree"])
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { repository: false, branch: null, files: [], diff: "", truncated: false }
  }
  const [branch, status, diff] = await Promise.all([
    git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    // HEAD may not exist in a fresh repository; fall back to the index then.
    git(directory, ["diff", "HEAD", "--no-color", "--no-ext-diff"]).then((result) =>
      result.code === 0 ? result : git(directory, ["diff", "--cached", "--no-color", "--no-ext-diff"]),
    ),
  ])
  const truncated = diff.stdout.length > MAX_DIFF
  return {
    repository: true,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    files: parseStatus(status.stdout),
    diff: truncated ? diff.stdout.slice(0, MAX_DIFF) : diff.stdout,
    truncated,
  }
}
