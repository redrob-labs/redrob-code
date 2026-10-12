import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import type { EngineInfo, EngineSource, EngineState } from "../shared/bridge"
import { createLineScanner } from "./listening"

/**
 * Runs the engine as a child process and keeps it running.
 *
 * One engine per app session, on 127.0.0.1 and a port the OS picks, behind a random Basic credential
 * that only this process and the interface know. The engine serves every project directory itself
 * (each request names its location), so opening another project never restarts it.
 */

export type EngineOptions = {
  binary: string
  source: EngineSource
  env: Record<string, string | undefined>
  /** How long to wait for the listening line before treating the start as failed. */
  startTimeoutMs?: number
  /** Restarts after an unexpected exit before giving up and showing the error. */
  maxRestarts?: number
  onState: (state: EngineState) => void
  fetch?: typeof globalThis.fetch
  spawnProcess?: typeof spawn
  platform?: NodeJS.Platform
}

const LOG_LIMIT = 200_000

export function createCredentials() {
  const username = "redrob"
  const password = randomBytes(24).toString("base64url")
  const token = Buffer.from(`${username}:${password}`).toString("base64")
  return { username, password, authToken: token, authorization: `Basic ${token}` }
}

export class EngineManager {
  private child: ChildProcess | null = null
  private info: EngineInfo | null = null
  private logs = ""
  private restarts = 0
  private stopping = false
  private readonly credentials = createCredentials()
  private readonly options: Required<Omit<EngineOptions, "spawnProcess" | "fetch" | "platform">> &
    Pick<EngineOptions, "spawnProcess" | "fetch" | "platform">

  constructor(options: EngineOptions) {
    this.options = { startTimeoutMs: 30_000, maxRestarts: 3, ...options }
  }

  current(): EngineInfo | null {
    return this.info
  }

  output(): string {
    return this.logs
  }

  async start(): Promise<EngineInfo> {
    this.stopping = false
    this.options.onState({ status: "starting" })
    try {
      const info = await this.launch()
      this.info = info
      this.restarts = 0
      this.options.onState({ status: "ready", url: info.url, version: await this.version(info), source: info.source })
      return info
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.options.onState({ status: "failed", message, attempts: this.restarts + 1 })
      throw error
    }
  }

  async restart(): Promise<EngineInfo> {
    await this.stop()
    this.restarts = 0
    return this.start()
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    this.child = null
    this.info = null
    if (child && child.exitCode === null && child.pid) {
      await killTree(child, this.options.platform ?? process.platform)
    }
    this.options.onState({ status: "stopped" })
  }

  private append(text: string) {
    this.logs = (this.logs + text).slice(-LOG_LIMIT)
  }

  private launch(): Promise<EngineInfo> {
    const platform = this.options.platform ?? process.platform
    const spawnProcess = this.options.spawnProcess ?? spawn
    const env: Record<string, string | undefined> = {
      ...this.options.env,
      REDROB_SERVER_USERNAME: this.credentials.username,
      REDROB_SERVER_PASSWORD: this.credentials.password,
      REDROB_CLIENT: "desktop",
    }
    // The bundled copy is updated by the app's own updater. Letting it update itself would rewrite a
    // file inside a signed application bundle.
    if (this.options.source === "bundled") env["REDROB_DISABLE_AUTOUPDATE"] = "1"

    return new Promise<EngineInfo>((resolve, reject) => {
      const child = spawnProcess(this.options.binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
        env: env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // Its own process group on macOS and Linux, so stopping it also stops what it started.
        detached: platform !== "win32",
      })
      this.child = child
      let settled = false
      const timer = setTimeout(() => {
        fail(new Error(`The engine did not start within ${Math.round(this.options.startTimeoutMs / 1000)}s.`))
      }, this.options.startTimeoutMs)

      const fail = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void killTree(child, platform)
        reject(error)
      }

      const scan = createLineScanner((url) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          url,
          authorization: this.credentials.authorization,
          authToken: this.credentials.authToken,
          source: this.options.source,
          binary: this.options.binary,
        })
      })

      child.stdout?.setEncoding("utf8")
      child.stderr?.setEncoding("utf8")
      child.stdout?.on("data", (chunk: string) => {
        this.append(chunk)
        scan(chunk)
      })
      child.stderr?.on("data", (chunk: string) => this.append(chunk))
      child.once("error", (error) => fail(error))
      child.once("exit", (code, signal) => {
        this.append(`\n[engine exited with ${signal ?? `code ${code}`}]\n`)
        if (!settled) {
          fail(new Error(`The engine exited before it was ready (${signal ?? `code ${code}`}).`))
          return
        }
        if (this.child === child) this.child = null
        if (!this.stopping) void this.recover()
      })
    })
  }

  /** An exit nobody asked for: try again a few times with a growing delay, then report it. */
  private async recover() {
    this.info = null
    if (this.restarts >= this.options.maxRestarts) {
      this.options.onState({
        status: "failed",
        message: "The engine stopped unexpectedly and could not be restarted.",
        attempts: this.restarts,
      })
      return
    }
    this.restarts += 1
    await new Promise((done) => setTimeout(done, 500 * 2 ** this.restarts))
    if (this.stopping) return
    await this.start().catch(() => undefined)
  }

  private async version(info: EngineInfo): Promise<string | null> {
    const fetcher = this.options.fetch ?? globalThis.fetch
    try {
      // The v1 health route is the one that names the version (handlers/global.ts).
      const response = await fetcher(`${info.url}/global/health`, { headers: { Authorization: info.authorization } })
      if (!response.ok) return null
      const body = (await response.json()) as { version?: unknown }
      return typeof body.version === "string" ? body.version : null
    } catch {
      return null
    }
  }
}

/** Stops a process and everything it started. */
export function killTree(child: ChildProcess, platform: NodeJS.Platform): Promise<void> {
  return new Promise((resolve) => {
    if (!child.pid || child.exitCode !== null) return resolve()
    const done = () => resolve()
    child.once("exit", done)
    const fallback = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {}
      resolve()
    }, 5_000)
    child.once("exit", () => clearTimeout(fallback))
    if (platform === "win32") {
      // `/T` takes the tree. Without it the engine's language servers and shells survive, and holding
      // files open in a worktree is what makes deleting that worktree fail with EBUSY later.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).once(
        "error",
        () => child.kill(),
      )
      return
    }
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {
      child.kill("SIGTERM")
    }
  })
}
