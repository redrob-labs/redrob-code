/**
 * The shared daemon, from an app: find it or start it, attach, keep the attachment alive.
 *
 * docs/LOCAL-ENGINE-API.md, section 3. One `redrob serve --register` per user; this is how every
 * Redrob app written in JavaScript reaches it. The fast path is a file read and a health check and
 * spawns nothing; only when no healthy daemon of a usable version is registered does this run
 * `redrob service start --json`, which holds the start logic in one place (the CLI).
 *
 * Deliberately plain: no Effect, no generated client, so it can run in an Electron main process or
 * a Node sidecar that has nothing else from this SDK loaded.
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type DaemonRecord = {
  readonly id: string
  readonly version: string
  readonly url: string
  readonly port: number
  readonly pid: number
  readonly secret: string
}

export type DaemonConnection = {
  readonly url: string
  readonly headers: { readonly Authorization: string }
  readonly record: DaemonRecord
}

export type DaemonOptions = {
  /** The `redrob` binary. Default: `REDROB_CODE_BIN`, then `~/.redrob/bin/redrob`, then `redrob` on PATH. */
  readonly bin?: string
  readonly env?: NodeJS.ProcessEnv
  /** Minutes with no attached app before a daemon this call starts exits. 0 keeps it up. Default 10. */
  readonly idleExitMinutes?: number
  readonly timeoutMs?: number
  readonly fetch?: typeof fetch
}

const USERNAME = "redrob"

export function daemonRecordPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.REDROB_RUN_DIR?.trim() || path.join(os.homedir(), ".redrob", "run"), "server.json")
}

/**
 * Key the engine uses for a project directory: absolute, normalised, lower-cased on Windows,
 * SHA-256 hex. Must match `ConfigPaths.directoryKey` in the engine.
 */
export function directoryKey(directory: string): string {
  let resolved = path.resolve(directory).replace(/[\\/]+$/, "")
  if (process.platform === "win32") resolved = resolved.toLowerCase()
  return createHash("sha256").update(resolved).digest("hex")
}

/**
 * Where an app writes engine config for ONE directory it works in: `<state>/directories/<key>/`,
 * holding `redrob.json` (or `.jsonc`). The engine reads it for every instance on that directory,
 * after the global config and before the project's own `redrob.json`, so the project still wins.
 * Outside the project tree on purpose: it never touches the user's files and never shows in git.
 * Write the file, then `POST /instance/dispose` for the directory so the running instance
 * reloads. `<state>` is `$XDG_STATE_HOME/redrob`, else `~/.local/state/redrob`.
 */
export function directoryConfigDir(directory: string, env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state")
  return path.join(state, "redrob", "directories", directoryKey(directory))
}

export function daemonHeaders(secret: string): { Authorization: string } {
  return { Authorization: `Basic ${Buffer.from(`${USERNAME}:${secret}`).toString("base64")}` }
}

/** Where the engine binary is, by the resolution order in docs/LOCAL-ENGINE-API.md. */
export async function resolveRedrobBin(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const explicit = env.REDROB_CODE_BIN?.trim()
  if (explicit) return explicit
  const home = path.join(os.homedir(), ".redrob", "bin", process.platform === "win32" ? "redrob.exe" : "redrob")
  if (
    await fs.stat(home).then(
      () => true,
      () => false,
    )
  )
    return home
  return "redrob"
}

function isRecord(value: unknown): value is DaemonRecord {
  if (typeof value !== "object" || value === null) return false
  const v = value as { [key: string]: unknown }
  return (
    typeof v.id === "string" &&
    typeof v.version === "string" &&
    typeof v.url === "string" &&
    typeof v.port === "number" &&
    typeof v.pid === "number" &&
    typeof v.secret === "string"
  )
}

export async function readDaemonRecord(env: NodeJS.ProcessEnv = process.env): Promise<DaemonRecord | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(daemonRecordPath(env), "utf8"))
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

export async function daemonHealthy(record: DaemonRecord, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${record.url.replace(/\/+$/, "")}/api/health`, {
      headers: daemonHeaders(record.secret),
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) return false
    const body = (await response.json().catch(() => null)) as { healthy?: unknown } | null
    return body?.healthy === true
  } catch {
    return false
  }
}

/** The registered daemon, if it answers. Spawns nothing. */
export async function currentDaemon(options: DaemonOptions = {}): Promise<DaemonConnection | undefined> {
  const env = options.env ?? process.env
  const record = await readDaemonRecord(env)
  if (!record) return undefined
  if (!(await daemonHealthy(record, options.fetch))) return undefined
  return { url: record.url, headers: daemonHeaders(record.secret), record }
}

function runServiceStart(options: DaemonOptions, bin: string): Promise<DaemonRecord> {
  const env = options.env ?? process.env
  const idle = options.idleExitMinutes ?? 10
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["service", "start", "--json", "--idle-exit", String(idle)], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    let out = ""
    let err = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`redrob service start did not answer in ${options.timeoutMs ?? 20_000}ms`))
    }, options.timeoutMs ?? 20_000)
    child.stdout.on("data", (chunk) => (out += chunk.toString()))
    child.stderr.on("data", (chunk) => (err += chunk.toString()))
    child.on("error", (cause) => {
      clearTimeout(timer)
      reject(new Error(`Could not run ${bin}: ${cause.message}. Install Redrob Code first.`))
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      const line = out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("{"))
        .pop()
      if (code !== 0 || !line) {
        reject(new Error(`redrob service start failed (exit ${code}): ${err.trim() || out.trim()}`))
        return
      }
      const value: unknown = JSON.parse(line)
      if (!isRecord(value)) {
        reject(new Error("redrob service start printed something that is not a daemon record"))
        return
      }
      resolve(value)
    })
  })
}

/**
 * The shared daemon: the registered one when it answers, otherwise the one `redrob service start`
 * finds or starts. Version policy (an older daemon is replaced) lives in the CLI, not here, so the
 * fast path is taken only for a daemon that is healthy; the CLI is asked whenever there is doubt.
 */
export async function connectOrStart(options: DaemonOptions = {}): Promise<DaemonConnection> {
  const found = await currentDaemon(options)
  if (found) return found
  const bin = options.bin ?? (await resolveRedrobBin(options.env))
  const record = await runServiceStart(options, bin)
  return { url: record.url, headers: daemonHeaders(record.secret), record }
}

export type Attachment = {
  readonly id: string
  /** Detach and stop the heartbeat. Safe to call twice. */
  readonly detach: () => Promise<void>
}

/**
 * Tell the daemon this app depends on it, and keep saying so. The daemon drops an attachment whose
 * heartbeats stop (an app that crashed) and exits once nobody has been attached for its idle window,
 * so an app that wants the engine to stay up must hold an attachment for as long as it runs.
 */
export async function attach(
  connection: DaemonConnection,
  app: string,
  options: { readonly pid?: number; readonly fetch?: typeof fetch } = {},
): Promise<Attachment> {
  const fetchImpl = options.fetch ?? fetch
  const base = connection.url.replace(/\/+$/, "")
  const headers = { ...connection.headers, "content-type": "application/json" }
  const response = await fetchImpl(`${base}/api/clients`, {
    method: "POST",
    headers,
    body: JSON.stringify({ app, pid: options.pid ?? process.pid }),
  })
  if (!response.ok) throw new Error(`The engine refused the attachment (${response.status})`)
  const client = (await response.json()) as { id: string }
  const list = (await fetchImpl(`${base}/api/clients`, { headers: connection.headers })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as { ttlMs?: number } | null
  const every = Math.max(5_000, Math.floor((list?.ttlMs ?? 90_000) / 3))
  let stopped = false
  const beat = async () => {
    if (stopped) return
    const r = await fetchImpl(`${base}/api/clients/${client.id}/heartbeat`, { method: "POST", headers }).catch(
      () => undefined,
    )
    // 404: the daemon restarted (or dropped us); attach again so it keeps counting this app.
    if (r && r.status === 404) {
      const again = await fetchImpl(`${base}/api/clients`, {
        method: "POST",
        headers,
        body: JSON.stringify({ app, pid: options.pid ?? process.pid }),
      }).catch(() => undefined)
      if (again?.ok) client.id = ((await again.json()) as { id: string }).id
    }
  }
  const timer = setInterval(() => void beat(), every)
  timer.unref?.()
  return {
    get id() {
      return client.id
    },
    detach: async () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      await fetchImpl(`${base}/api/clients/${client.id}`, { method: "DELETE", headers: connection.headers }).catch(
        () => undefined,
      )
    },
  }
}
