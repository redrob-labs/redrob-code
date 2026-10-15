export * as SharedAccount from "./shared-account"

import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"

/**
 * Redrob Launcher's shared sign-in, read as this app's LAST fallback for the console key.
 *
 * The launcher signs a computer in to a workspace once and writes the key to one file every Redrob app
 * may read. The contract is redrob-launcher `docs/shared-account.md`; the rules a reader follows:
 *
 * 1. Read, never write. Nothing here creates, rewrites or deletes the file. `DELETE /auth/redrob` removes
 *    the engine's own `auth.json` entry and nothing else, after which the shared file is the fallback again.
 * 2. Read it when it is needed, not once at startup. The person may sign in or out of the launcher while
 *    the engine runs, so there is no cache here: every call hits the disk.
 * 3. A missing file, unreadable JSON, a non-object, or an empty `apiKey` all mean "not signed in".
 * 4. The key is never logged. Only `accountName` and `apiKeyName` are for showing to a person.
 * 5. The app's own key wins. `REDROB_API_KEY`, the Credential store and `auth.json` are consulted first by
 *    every caller; this module is only ever the end of that chain.
 */

export const FILE = "account.json"

/** Replaces the directory on every platform when set and not empty (tests, portable setups). */
export const DIR_ENV = "REDROB_SHARED_DIR"

export interface Info {
  readonly apiKey: string
  readonly apiKeyName?: string
  readonly accountName?: string
  readonly apiBaseUrl?: string
}

/** Where the launcher writes the file on this platform. Resolved on every call so the env override is live. */
export function directory(): string {
  const override = process.env[DIR_ENV]
  if (override && override.trim()) return override
  if (process.platform === "win32") {
    const appdata = process.env["APPDATA"] || path.join(os.homedir(), "AppData", "Roaming")
    return path.join(appdata, "Redrob", "Shared")
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "ai.redrob.shared")
  }
  const xdg = process.env["XDG_CONFIG_HOME"]
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".config")
  return path.join(base, "redrob-shared")
}

export function file(): string {
  return path.join(directory(), FILE)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

/**
 * The file's text as the app's own shape. Every field is `unknown` on the way in because this is the
 * boundary: a half-written or hand-edited file is not a key.
 */
export function parse(text: string): Info | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const json = raw as Record<string, unknown>
  const apiKey = asString(json["apiKey"])
  if (!apiKey) return undefined
  return {
    apiKey,
    apiKeyName: asString(json["apiKeyName"]),
    accountName: asString(json["accountName"]),
    apiBaseUrl: asString(json["apiBaseUrl"]),
  }
}

/** The launcher's sign-in right now; `undefined` when there is none. Never throws. */
export async function read(): Promise<Info | undefined> {
  try {
    return parse(await fs.readFile(file(), "utf8"))
  } catch {
    return undefined
  }
}

/** The key alone, for callers that only need to spend it. */
export async function apiKey(): Promise<string | undefined> {
  return (await read())?.apiKey
}
