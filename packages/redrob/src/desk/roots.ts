/**
 * Which folders a paired device may browse, edit and open a terminal in: the work folders of
 * sessions on this daemon (a session's `location.directory`, the worktree for a code chat). The
 * file, find, command and terminal routes carry the folder as `?directory=` and are refused (403)
 * for any other folder; a path inside one must stay inside it after symlinks are followed.
 */
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import type { DaemonApi } from "./daemon"

/** A positive answer is reused this long. A folder never becomes a root by waiting. */
const KNOWN_TTL_MS = 60_000

/** Absolute, normalized, no trailing separator, no NUL; undefined for anything else. */
export function absolute(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return undefined
  if (value.includes("\0") || !path.isAbsolute(value)) return undefined
  return path.resolve(value.normalize("NFC"))
}

/** Whether `child` is `parent` or inside it (both resolved). */
export function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** The query string of a request path, parsed. */
export function queryOf(requestPath: string): URLSearchParams {
  const mark = requestPath.indexOf("?")
  return new URLSearchParams(mark >= 0 ? requestPath.slice(mark + 1) : "")
}

/** The real path of `target`, or of its nearest existing parent with the rest appended. */
async function settle(target: string): Promise<string> {
  const missing: string[] = []
  let current = target
  for (;;) {
    const real = await realpath(current).catch(() => undefined)
    if (real !== undefined) return path.join(real, ...missing.toReversed())
    const parent = path.dirname(current)
    if (parent === current) return target
    missing.push(path.basename(current))
    current = parent
  }
}

export class RootError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly reason: string,
  ) {
    super(reason)
  }
}

export class Roots {
  private readonly known = new Map<string, number>()

  constructor(private readonly daemon: Pick<DaemonApi, "raw">) {}

  /** A folder this desk made for a session (a worktree), known before the session exists. */
  add(directory: string): void {
    this.known.set(path.resolve(directory), Date.now())
  }

  /** The folder as a root, resolved; undefined when no session works in it. */
  async root(value: unknown): Promise<string | undefined> {
    const directory = absolute(value)
    if (!directory) return undefined
    const at = this.known.get(directory)
    if (at !== undefined && Date.now() - at < KNOWN_TTL_MS) return directory
    const info = await stat(directory).catch(() => undefined)
    if (!info?.isDirectory()) return undefined
    const real = await realpath(directory).catch(() => directory)
    for (const candidate of new Set([directory, real])) {
      const query = new URLSearchParams({ directory: candidate, limit: "1" })
      const result = await this.daemon.raw("GET", `/api/session?${query}`).catch(() => undefined)
      const data = (result?.body as { data?: unknown } | undefined)?.data
      if (result && result.status >= 200 && result.status < 300 && Array.isArray(data) && data.length > 0) {
        this.known.set(directory, Date.now())
        return directory
      }
    }
    return undefined
  }

  /**
   * A path inside a root: relative to `directory`, or absolute. The root is `directory` when given,
   * else the nearest known parent of an absolute path. Refused (403) when it leaves the root,
   * through `..` or a symlink, or names something inside `.git`.
   */
  async resolve(directory: unknown, value: unknown): Promise<{ root: string; file: string }> {
    if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0"))
      throw new RootError(400, "bad_path")
    let root: string | undefined
    if (directory !== undefined) root = await this.root(directory)
    else if (path.isAbsolute(value)) {
      for (let current = path.dirname(path.resolve(value)); ; current = path.dirname(current)) {
        root = await this.root(current)
        if (root || path.dirname(current) === current) break
      }
    }
    if (!root) throw new RootError(403, "not_a_work_folder")
    const file = path.resolve(root, value.normalize("NFC"))
    if (!within(root, file) || file === root) throw new RootError(403, "outside_work_folder")
    if (path.relative(root, file).split(path.sep).includes(".git")) throw new RootError(403, "git_folder")
    const [realRoot, realFile] = await Promise.all([realpath(root).catch(() => root), settle(file)])
    if (!within(realRoot, realFile) || realFile === realRoot) throw new RootError(403, "outside_work_folder")
    return { root, file }
  }
}
