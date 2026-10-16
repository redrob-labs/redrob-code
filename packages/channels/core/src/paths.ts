/**
 * Where the channel files live: `$HOME/.redrob/channels.json` (non-secret config),
 * `$HOME/.redrob/channels/secrets.json` (tokens, mode 0600) and
 * `$HOME/.redrob/channels/sessions.json` (conversation -> session map).
 *
 * `REDROB_CHANNELS_HOME` moves the whole set, for tests and odd homes, the way `REDROB_RUN_DIR`
 * moves the daemon record.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export function home(env: NodeJS.ProcessEnv = process.env): string {
  return env.REDROB_CHANNELS_HOME?.trim() || path.join(os.homedir(), ".redrob")
}

export function configFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(home(env), "channels.json")
}

export function directory(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(home(env), "channels")
}

export function secretsFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(directory(env), "secrets.json")
}

export function sessionsFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(directory(env), "sessions.json")
}

/** Parsed JSON, or undefined when the file is missing or does not parse. */
export async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown
  } catch {
    return undefined
  }
}

/** Write atomically (temp file + rename), creating the folder, with the given file mode. */
export async function writeJson(file: string, value: unknown, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode })
  await fs.chmod(temp, mode).catch(() => undefined)
  await fs.rename(temp, file)
}
