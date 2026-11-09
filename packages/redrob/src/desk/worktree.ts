/**
 * One chat = one branch (code-work design 4.3, 5.2). Session create may carry `branch` and `repo`;
 * the desk then runs the session in a git worktree for that branch, beside the checkout:
 *
 *   <checkout parent>/<repo name>-wt-<last part of the branch>      e.g. ~/code/app-wt-login-401
 *
 * The checkout is `repo` when it is an absolute path, else the session's `location.directory`.
 * `repo` may also be a GitHub `owner/name`: a checkout whose `origin` is that repository is used,
 * and when there is none it is cloned once into `REDROB_DESK_REPOS` (default `~/redrob`) with this
 * computer's own git sign-in. The branch is the local one when it exists, else `origin/<branch>`,
 * else a new branch from the default branch. A worktree already on that branch is used again, so
 * the next message in the chat continues there.
 */
import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

const GIT_TIMEOUT_MS = 120_000
const CLONE_TIMEOUT_MS = 15 * 60_000

export class WorktreeError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500,
    message: string,
  ) {
    super(message)
  }
}

type Git = { code: number; stdout: string; stderr: string }

async function git(args: string[], cwd?: string, timeout = GIT_TIMEOUT_MS): Promise<Git> {
  const child = Bun.spawn(["git", ...args], {
    ...(cwd ? { cwd } : {}),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  const timer = setTimeout(() => child.kill(), timeout)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, stdout: stdout.trim(), stderr: stderr.trim() }
  } finally {
    clearTimeout(timer)
  }
}

async function isDir(value: string): Promise<boolean> {
  return (await stat(value).catch(() => undefined))?.isDirectory() === true
}

/** A branch name git accepts and that cannot be read as an option or climb a path. */
export function validBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock") &&
    !value.endsWith(".")
  )
}

/** `owner/name` of a GitHub repository. */
const SLUG = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/

/** The folder-safe last part of a branch: `fix/login-401` -> `login-401`. */
export function branchTail(branch: string): string {
  const tail = branch.split("/").pop() ?? branch
  return tail.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "work"
}

/** Whether a remote URL is the GitHub repository `owner/name` (https or ssh, any case, `.git` or not). */
export function sameRepo(url: string, slug: string): boolean {
  const match = url.trim().match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
  return match !== null && `${match[1]}/${match[2]}`.toLowerCase() === slug.toLowerCase()
}

async function top(directory: string): Promise<string | undefined> {
  const result = await git(["rev-parse", "--show-toplevel"], directory)
  return result.code === 0 && result.stdout ? result.stdout : undefined
}

/** The main checkout of a repository (not a worktree of it). */
async function mainCheckout(directory: string): Promise<string | undefined> {
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], directory)
  if (common.code !== 0 || !common.stdout) return top(directory)
  return path.basename(common.stdout) === ".git" ? path.dirname(common.stdout) : top(directory)
}

export function reposRoot(): string {
  return process.env.REDROB_DESK_REPOS?.trim() || path.join(homedir(), "redrob")
}

/** The checkout to branch from. */
async function checkout(repo: unknown, directory: unknown): Promise<string> {
  if (typeof repo === "string" && path.isAbsolute(repo)) {
    const found = (await isDir(repo)) ? await mainCheckout(repo) : undefined
    if (!found) throw new WorktreeError(404, "repo is not a git checkout")
    return found
  }
  const slug = typeof repo === "string" ? repo.match(SLUG) : null
  if (repo !== undefined && !slug) throw new WorktreeError(400, "repo must be an absolute path or owner/name")
  if (typeof directory === "string" && path.isAbsolute(directory) && (await isDir(directory))) {
    const found = await mainCheckout(directory)
    if (found) {
      if (!slug) return found
      const origin = await git(["remote", "get-url", "origin"], found)
      if (origin.code === 0 && sameRepo(origin.stdout, repo as string)) return found
    }
  }
  if (!slug) throw new WorktreeError(400, "no checkout: give repo or a location directory inside one")
  const target = path.join(reposRoot(), slug[2]!)
  if (await isDir(path.join(target, ".git"))) {
    const origin = await git(["remote", "get-url", "origin"], target)
    if (origin.code === 0 && sameRepo(origin.stdout, repo as string)) return target
    throw new WorktreeError(409, `${target} is a different repository`)
  }
  if (await isDir(target)) throw new WorktreeError(409, `${target} exists and is not a git checkout`)
  const cloned = await git(["clone", "--", `https://github.com/${slug[1]}/${slug[2]}.git`, target], undefined, CLONE_TIMEOUT_MS)
  if (cloned.code !== 0) throw new WorktreeError(500, `git clone failed: ${cloned.stderr.slice(-400)}`)
  return target
}

/** The branch a worktree has checked out, or undefined. */
async function currentBranch(directory: string): Promise<string | undefined> {
  const result = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], directory)
  return result.code === 0 ? result.stdout : undefined
}

async function hasRef(repo: string, ref: string): Promise<boolean> {
  return (await git(["show-ref", "--verify", "--quiet", ref], repo)).code === 0
}

/** The default branch to start a new branch from: `origin/HEAD`, else the checkout's HEAD. */
async function base(repo: string): Promise<string> {
  const head = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], repo)
  if (head.code === 0 && head.stdout) return head.stdout.replace(/^refs\/remotes\//, "")
  return "HEAD"
}

export type Prepared = { readonly directory: string; readonly branch: string; readonly repo: string; readonly created: boolean }

/** The worktree for `branch` of the checkout `repo` / `directory` names; made when missing. */
export async function prepare(input: { branch: unknown; repo?: unknown; directory?: unknown }): Promise<Prepared> {
  if (!validBranch(input.branch)) throw new WorktreeError(400, "bad branch name")
  const branch = input.branch
  if ((await git(["check-ref-format", "--branch", branch])).code !== 0) throw new WorktreeError(400, "bad branch name")
  const repo = await checkout(input.repo, input.directory)
  const directory = path.join(path.dirname(repo), `${path.basename(repo)}-wt-${branchTail(branch)}`)

  if (await isDir(directory)) {
    const owner = await mainCheckout(directory)
    const current = await currentBranch(directory)
    if (owner && path.resolve(owner) === path.resolve(repo) && current === branch)
      return { directory, branch, repo, created: false }
    throw new WorktreeError(409, `${directory} exists and is not the worktree of ${branch}`)
  }

  // Best effort: a machine offline still gets its worktree from what it has.
  await git(["fetch", "--quiet", "origin"], repo).catch(() => undefined)
  const args = (await hasRef(repo, `refs/heads/${branch}`))
    ? ["worktree", "add", directory, branch]
    : (await hasRef(repo, `refs/remotes/origin/${branch}`))
      ? ["worktree", "add", "--track", "-b", branch, directory, `origin/${branch}`]
      : ["worktree", "add", "--no-track", "-b", branch, directory, await base(repo)]
  const added = await git(args, repo)
  if (added.code !== 0) {
    const message = added.stderr.slice(-400)
    // Checked out in another worktree already.
    if (/already (checked out|used by worktree)/.test(message)) throw new WorktreeError(409, message)
    throw new WorktreeError(500, `git worktree add failed: ${message}`)
  }
  return { directory, branch, repo, created: true }
}
