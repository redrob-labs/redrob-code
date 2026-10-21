/**
 * Find the shared daemon or start it: what `redrob service start`, `redrob acp --attach` and every
 * app do first. docs/LOCAL-ENGINE-API.md, "One daemon, not one per product".
 *
 *   1. A record whose daemon answers health with this binary's version: use it.
 *   2. A record whose daemon answers but is another version: stop it (an upgrade restarts the
 *      daemon; attached apps re-read the record and reconnect).
 *   3. A record whose pid is gone, or no record: start `redrob serve --register` detached and wait
 *      for the new record to answer.
 */
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { InstallationVersion } from "@redrob-code/core/installation/version"
import * as Registry from "./registry"

export type Connection = { readonly url: string; readonly headers: { Authorization: string }; readonly record: Registry.Record }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The daemon named by the record, if it is alive, healthy and this version. */
export async function current(env: NodeJS.ProcessEnv = process.env): Promise<Connection | undefined> {
  const record = await Registry.read(env)
  if (!record) return undefined
  if (!Registry.alive(record.pid)) {
    await Registry.remove(record.id, env)
    return undefined
  }
  if (!(await Registry.healthy(record))) return undefined
  if (record.version !== InstallationVersion) return undefined
  return { url: record.url, headers: Registry.headers(record.secret), record }
}

/** How this very binary is launched again, so the daemon is the same build as the caller. */
export function selfCommand(): { command: string; args: string[] } {
  const compiled = path.basename(process.execPath).replace(/\.exe$/, "") !== "bun"
  if (compiled) return { command: process.execPath, args: [] }
  const entrypoint = process.argv[1]
  if (!entrypoint) throw new Error("Failed to resolve the CLI entrypoint to start the daemon with")
  return { command: process.execPath, args: [entrypoint] }
}

export async function stop(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const record = await Registry.read(env)
  if (!record) return false
  // A stale record may name a pid another process now owns: only signal a daemon that answers
  // with this record's own secret.
  if (!Registry.alive(record.pid) || !(await Registry.healthy(record))) {
    await Registry.remove(record.id, env)
    return false
  }
  try {
    process.kill(record.pid, "SIGTERM")
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 100 && Registry.alive(record.pid); i++) await sleep(50)
  if (Registry.alive(record.pid)) {
    try {
      process.kill(record.pid, "SIGKILL")
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 100 && Registry.alive(record.pid); i++) await sleep(50)
  }
  await Registry.remove(record.id, env)
  return true
}

export type StartOptions = {
  readonly env?: NodeJS.ProcessEnv
  /** Minutes with no attached app before the daemon exits. 0 keeps it up. Default 10. */
  readonly idleExitMinutes?: number
  readonly waitMs?: number
}

export async function connectOrStart(options: StartOptions = {}): Promise<Connection> {
  const env = options.env ?? process.env
  const found = await current(env)
  if (found) return found

  const stale = await Registry.read(env)
  if (stale && Registry.alive(stale.pid)) await stop(env)

  const self = selfCommand()
  const idle = options.idleExitMinutes ?? 10
  const child = spawn(self.command, [...self.args, "serve", "--register", "--idle-exit", String(idle)], {
    detached: true,
    stdio: "ignore",
    env,
    // The daemon outlives its caller. Inheriting the caller's cwd (an app's install folder) would
    // hold that folder open for the daemon's whole life and block the app's Windows update.
    cwd: os.homedir(),
  })
  child.unref()

  const deadline = Date.now() + (options.waitMs ?? 15_000)
  while (Date.now() < deadline) {
    const record = await Registry.read(env)
    if (record && (!stale || record.id !== stale.id) && (await Registry.healthy(record))) {
      if (record.version !== InstallationVersion) {
        throw new Error(`The daemon that started is version ${record.version}, this binary is ${InstallationVersion}`)
      }
      return { url: record.url, headers: Registry.headers(record.secret), record }
    }
    await sleep(100)
  }
  throw new Error("The Redrob Code daemon did not start in time")
}

export type Attachment = {
  readonly id: string
  /** Detach and stop the heartbeat. Safe to call twice. */
  readonly detach: () => Promise<void>
}

/**
 * Tell the daemon this process depends on it, and keep saying so: `POST /api/clients`, then a
 * heartbeat every third of the daemon's TTL. The daemon exits once nobody has been attached for
 * its idle window, so `redrob acp --attach` must hold one for as long as its host keeps it open --
 * connecting alone leaves the daemon counting idle time under a live session. Mirrors
 * `attach()` in `@redrob-labs/sdk/daemon`.
 */
export async function attach(
  connection: Connection,
  app: string,
  options: { readonly pid?: number; readonly fetch?: typeof fetch } = {},
): Promise<Attachment> {
  const fetchImpl = options.fetch ?? fetch
  const base = connection.url.replace(/\/+$/, "")
  const headers = { ...connection.headers, "content-type": "application/json" }
  const body = JSON.stringify({ app, pid: options.pid ?? process.pid })
  const response = await fetchImpl(`${base}/api/clients`, { method: "POST", headers, body })
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
      const again = await fetchImpl(`${base}/api/clients`, { method: "POST", headers, body }).catch(() => undefined)
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

export * as Daemon from "./connect"
