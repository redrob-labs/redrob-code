/**
 * What each session last saw of a file. `read` records a file's stamp (modified time and size)
 * when the agent reads it, and `edit` / `apply_patch` / `write` record it again after they change
 * it. `write` replaces a whole file, so before it does, it checks the file still has the stamp the
 * agent saw: when someone else changed it since (the person in the editor panel, another tool),
 * the write is refused and the agent reads it again instead of overwriting their change.
 *
 * A file the agent never read is not checked, as before. Process memory only.
 */
export * as ReadStamps from "./stamps"

import { stat } from "node:fs/promises"
import { Effect } from "effect"

const MAX_SESSIONS = 500
const MAX_FILES = 2_000

const sessions = new Map<string, Map<string, string>>()

/** A file's stamp now; undefined when it does not exist. */
async function stampOf(file: string): Promise<string | undefined> {
  const info = await stat(file).catch(() => undefined)
  return info?.isFile() ? `${info.mtimeMs}:${info.size}` : undefined
}

function files(sessionID: string): Map<string, string> {
  let found = sessions.get(sessionID)
  if (found) {
    // Most recently used last, so the oldest session is dropped first.
    sessions.delete(sessionID)
    sessions.set(sessionID, found)
    return found
  }
  found = new Map()
  sessions.set(sessionID, found)
  if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!)
  return found
}

/** Remember the file as the session sees it now. */
export const record = (sessionID: string, file: string) =>
  Effect.promise(async () => {
    const stamp = await stampOf(file)
    const seen = files(sessionID)
    seen.delete(file)
    if (stamp === undefined) return
    seen.set(file, stamp)
    if (seen.size > MAX_FILES) seen.delete(seen.keys().next().value!)
  })

/**
 * Whether the session may overwrite the file: it never read it, the file is gone, or it still
 * has the stamp the session last saw.
 */
export const unchanged = (sessionID: string, file: string) =>
  Effect.promise(async () => {
    const seen = sessions.get(sessionID)?.get(file)
    if (seen === undefined) return true
    const now = await stampOf(file)
    return now === undefined || now === seen
  })

/** Forget a session (tests). */
export function forget(sessionID?: string): void {
  if (sessionID === undefined) sessions.clear()
  else sessions.delete(sessionID)
}
