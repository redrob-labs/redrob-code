/**
 * The desk settings the Redrob Launcher writes: `~/.redrob/desk/settings.json`
 * (`%USERPROFILE%\.redrob\desk\settings.json` on Windows). Only the launcher writes it; phones,
 * the web and the relay server cannot change it. Read on every call, so a change applies without a
 * restart.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export function settingsPath(): string {
  return path.join(homedir(), ".redrob", "desk", "settings.json")
}

/** Whether the launcher's "Allow Auto all from phone" switch is on. Missing or unreadable: off. */
export async function allowAutoAll(): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(settingsPath(), "utf8")) as { allowAutoAll?: unknown } | null
    return value?.allowAutoAll === true
  } catch {
    return false
  }
}
