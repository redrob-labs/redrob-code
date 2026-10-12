import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { git } from "./git"

/**
 * Where a contest keeps what it knows.
 *
 * Records and preferences live inside the repository's own git directory (`.git/redrob/`), so they are
 * per repository, never committed, never pushed, and gone if the clone is. Worktrees live outside the
 * repository under a short path, because Windows paths have a length limit and a worktree nested inside
 * the checkout would show up in the person's own tooling.
 */

export async function stateDir(repo: string) {
  const common = (await git(repo, ["rev-parse", "--git-common-dir"])).stdout.trim()
  const directory = path.resolve(repo, common, "redrob")
  mkdirSync(path.join(directory, "contests"), { recursive: true })
  return directory
}

export function worktreeRoot(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  if (env["REDROB_CONTEST_ROOT"]) return env["REDROB_CONTEST_ROOT"]
  if (platform === "win32")
    return path.join(env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local"), "Redrob", "contest")
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "redrob", "contest")
  return path.join(env["XDG_CACHE_HOME"] ?? path.join(os.homedir(), ".cache"), "redrob", "contest")
}

export function saveRecord(state: string, id: string, record: unknown) {
  writeFileSync(path.join(state, "contests", `${id}.json`), `${JSON.stringify(record, null, 2)}\n`)
}

export function loadRecord<T>(state: string, id: string): T {
  return JSON.parse(readFileSync(path.join(state, "contests", `${id}.json`), "utf8")) as T
}

export function listRecords(state: string) {
  return readdirSync(path.join(state, "contests"))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -5))
    .sort()
}

export type Preference = {
  contest: string
  time: number
  task: string
  chosen: string
  chosenModel: string
  judgeWinner: string | null
  judgeWinnerModel: string | null
  candidates: { slot: string; model: string; quality: number; points: number }[]
  reasons: string[]
}

/** One line per choice. Written BEFORE the reveal, so seeing the names cannot change what was chosen. */
export function recordPreference(state: string, preference: Preference) {
  appendFileSync(path.join(state, "preferences.jsonl"), `${JSON.stringify(preference)}\n`)
}

export function readPreferences(state: string): Preference[] {
  try {
    return readFileSync(path.join(state, "preferences.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Preference)
  } catch {
    return []
  }
}

export function readStandard(repo: string): string | null {
  for (const file of [path.join(repo, ".redrob", "standard.md"), path.join(repo, ".redrob", "STANDARD.md")]) {
    try {
      const text = readFileSync(file, "utf8").trim()
      if (text) return text.slice(0, 20_000)
    } catch {}
  }
  return null
}
