/**
 * The desk settings the Redrob Launcher writes: `~/.redrob/desk/settings.json`
 * (`%USERPROFILE%\.redrob\desk\settings.json` on Windows). Only the launcher writes settings; phones,
 * the web and the relay server cannot change it. Read on every call, so a change applies without a
 * restart.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export function settingsPath(): string {
  return path.join(homedir(), ".redrob", "desk", "settings.json")
}

/**
 * Whether a device may pick Auto all. On unless the launcher's "Allow Auto all from phone and web"
 * switch was turned off (`allowAutoAll: false`). Missing or unreadable file: on.
 */
export async function allowAutoAll(): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(settingsPath(), "utf8")) as { allowAutoAll?: unknown } | null
    return value?.allowAutoAll !== false
  } catch {
    return true
  }
}

export function eventsPath(): string {
  return path.join(homedir(), ".redrob", "desk", "events.jsonl")
}

/** Append one line to `~/.redrob/desk/events.jsonl`, which the launcher reads to tell the person at the PC. */
export async function appendEvent(event: Record<string, unknown>): Promise<void> {
  const file = eventsPath()
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n", "utf8")
}
