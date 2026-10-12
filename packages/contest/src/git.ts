import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { run } from "./proc"

/**
 * The git operations a contest needs. Every candidate gets its own worktree at the same base commit,
 * so builders never see each other's files and the person's own checkout is never touched until they
 * choose to apply a winner.
 */

const IDENTITY = [
  "-c",
  "user.name=Redrob Code",
  "-c",
  "user.email=contest@code.redrob.ai",
  "-c",
  "commit.gpgsign=false",
]

export async function git(cwd: string, args: string[], input?: string) {
  const result = await run("git", ["-c", "core.longpaths=true", "-c", "core.quotepath=false", ...args], { cwd, input })
  return result
}

async function must(cwd: string, args: string[], input?: string) {
  const result = await git(cwd, args, input)
  if (result.code !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  return result.stdout
}

export async function repoRoot(directory: string) {
  return (await must(directory, ["rev-parse", "--show-toplevel"])).trim()
}

export async function headCommit(directory: string) {
  return (await must(directory, ["rev-parse", "HEAD"])).trim()
}

export async function isClean(directory: string) {
  return (await must(directory, ["status", "--porcelain"])).trim() === ""
}

export async function currentBranch(directory: string) {
  const result = await git(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  return result.code === 0 ? result.stdout.trim() : null
}

/** A detached worktree at `base`. Detached, so no branch exists until a winner is applied. */
export async function addWorktree(repo: string, directory: string, base: string) {
  mkdirSync(path.dirname(directory), { recursive: true })
  rmSync(directory, { recursive: true, force: true })
  await must(repo, ["worktree", "add", "--detach", "--force", directory, base])
}

export async function removeWorktree(repo: string, directory: string) {
  // Never `--force` through a junction or symlink into the main tree: plain removal of a worktree
  // directory git itself created. Errors are ignored; `worktree prune` tidies the rest.
  await git(repo, ["worktree", "remove", "--force", directory])
  rmSync(directory, { recursive: true, force: true })
  await git(repo, ["worktree", "prune"])
}

/** Commits everything the builder changed and returns the candidate commit, or null when it changed nothing. */
export async function commitCandidate(worktree: string, message: string): Promise<string | null> {
  await must(worktree, ["add", "-A"])
  if ((await git(worktree, ["diff", "--cached", "--quiet"])).code === 0) return null
  await must(worktree, [...IDENTITY, "commit", "-q", "--no-verify", "-m", message])
  return headCommit(worktree)
}

export async function diff(cwd: string, from: string, to: string, extra: string[] = []) {
  return must(cwd, ["diff", "--no-color", "--no-ext-diff", "-M", ...extra, from, to])
}

export type FileChange = { path: string; status: "A" | "M" | "D" | "R" | "C" | "T"; from?: string }

export async function changedFiles(cwd: string, from: string, to: string): Promise<FileChange[]> {
  const output = await must(cwd, ["diff", "--name-status", "-M", "-z", from, to])
  const parts = output.split("\0").filter(Boolean)
  const files: FileChange[] = []
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]![0] as FileChange["status"]
    if (code === "R" || code === "C") {
      files.push({ status: code, from: parts[i + 1]!, path: parts[i + 2]! })
      i += 2
    } else {
      files.push({ status: code, path: parts[i + 1]! })
      i += 1
    }
  }
  return files
}

/** Keeps a commit reachable after its worktree is gone, so a losing candidate can still be inspected. */
export async function keepRef(repo: string, ref: string, commit: string) {
  await must(repo, ["update-ref", ref, commit])
}

/** Rewrites a candidate commit's message (for the provenance trailers) and returns the new commit. */
export async function rewriteMessage(repo: string, commit: string, message: string) {
  const tree = (await must(repo, ["rev-parse", `${commit}^{tree}`])).trim()
  const parent = (await must(repo, ["rev-parse", `${commit}^`])).trim()
  return (await must(repo, [...IDENTITY, "commit-tree", tree, "-p", parent, "-F", "-"], message)).trim()
}

export async function createBranch(repo: string, name: string, commit: string) {
  await must(repo, ["branch", name, commit])
}

export async function cherryPick(repo: string, commit: string) {
  await must(repo, [...IDENTITY, "cherry-pick", commit])
}

export type HistoryCommit = { sha: string; body: string }

/** Recent non-merge commits reachable from `base`, newest first. */
export async function history(repo: string, base: string, limit: number): Promise<HistoryCommit[]> {
  const output = await must(repo, ["log", "--no-merges", `-n${limit}`, "--format=%H%x00%B%x1e", base])
  return output
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, body] = entry.split("\0")
      return { sha: sha!.trim(), body: body ?? "" }
    })
}

export async function commitPatch(repo: string, sha: string) {
  const parent = await git(repo, ["rev-parse", "--verify", "--quiet", `${sha}^`])
  if (parent.code !== 0) return ""
  return diff(repo, `${sha}^`, sha)
}
