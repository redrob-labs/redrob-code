/**
 * The shared daemon's record: one `redrob serve --register` per user, found by every Redrob app.
 *
 * docs/LOCAL-ENGINE-API.md, section 3. The record lives at `$HOME/.redrob/run/server.json`, mode
 * 0600, and is the auth boundary: it carries the Basic secret the daemon was started with. A fresh
 * secret is drawn on every start, so a stale record never opens a running server, and an app that
 * loses its connection re-reads the file rather than keeping a secret of its own.
 *
 * Nothing here is Effect: the same logic is read from the yargs commands, from `acp --attach`, and
 * (as a copy of the read half) from the JS SDK, which cannot import this package.
 */
import { randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type Record = {
  /** Random per start; a client that saw a different id knows the daemon restarted. */
  readonly id: string
  readonly version: string
  readonly url: string
  readonly port: number
  readonly pid: number
  /** The Basic password (username `redrob`). Mode 0600 is what keeps it private. */
  readonly secret: string
}

export const USERNAME = "redrob"

/** `$HOME/.redrob/run`, or `REDROB_RUN_DIR` for tests and odd homes. */
export function directory(env: NodeJS.ProcessEnv = process.env): string {
  return env.REDROB_RUN_DIR?.trim() || path.join(os.homedir(), ".redrob", "run")
}

export function file(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(directory(env), "server.json")
}

export function newSecret(): string {
  return randomBytes(32).toString("base64url")
}

export function newID(): string {
  return randomUUID()
}

export function headers(secret: string): { Authorization: string } {
  return { Authorization: `Basic ${Buffer.from(`${USERNAME}:${secret}`).toString("base64")}` }
}

function isRecord(value: unknown): value is Record {
  if (typeof value !== "object" || value === null) return false
  const v = value as { [key: string]: unknown }
  return (
    typeof v.id === "string" &&
    typeof v.version === "string" &&
    typeof v.url === "string" &&
    typeof v.port === "number" &&
    typeof v.pid === "number" &&
    v.pid > 0 &&
    typeof v.secret === "string"
  )
}

/** The record on disk, or undefined when there is none or it does not parse. */
export async function read(env: NodeJS.ProcessEnv = process.env): Promise<Record | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file(env), "utf8"))
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Write atomically (temp file + rename) with mode 0600. */
export async function write(record: Record, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const target = file(env)
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temp = `${target}.${record.id}.tmp`
  await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600 })
  await fs.rename(temp, target)
}

/** Remove the record, but only if it is still ours: a newer daemon's record is left alone. */
export async function remove(id: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const current = await read(env)
  if (id !== undefined && current && current.id !== id) return
  await fs.rm(file(env), { force: true })
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else. Still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Whether the daemon the record names answers `/api/health` with its own secret. */
export async function healthy(
  record: Record,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2_000,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${record.url.replace(/\/+$/, "")}/api/health`, {
      headers: headers(record.secret),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return false
    const body = (await response.json().catch(() => null)) as { healthy?: unknown } | null
    return body?.healthy === true
  } catch {
    return false
  }
}
