import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { detectProject, runSetup } from "./checks"
import * as Git from "./git"
import { worktreeRoot } from "./store"

/**
 * A live preview of one candidate, for web projects.
 *
 * Candidates outlive their contest worktrees as refs, so a preview checks the ref out into its own
 * worktree, installs dependencies, and runs the project's dev server on a free loopback port. Every
 * preview gets its own port, so candidates can be open side by side. Stopping one stops the dev server
 * and everything it started, then removes the worktree.
 */

export type PreviewPlan = { command: string; port: number; env: Record<string, string> }

/** The dev command a web project declares, or null when it is not one. */
export function previewCommand(directory: string, port: number): PreviewPlan | null {
  const file = path.join(directory, "package.json")
  if (!existsSync(file)) return null
  let pkg: { scripts?: Record<string, string>; packageManager?: string }
  try {
    pkg = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
  const scripts = pkg.scripts ?? {}
  const name = scripts["dev"] ? "dev" : scripts["start"] ? "start" : scripts["preview"] ? "preview" : null
  if (!name) return null
  const has = (lock: string) => existsSync(path.join(directory, lock))
  const declared = /^(bun|pnpm|yarn|npm)@/.exec(pkg.packageManager ?? "")?.[1]
  const pm =
    has("bun.lock") || has("bun.lockb")
      ? "bun"
      : has("pnpm-lock.yaml")
        ? "pnpm"
        : has("yarn.lock")
          ? "yarn"
          : (declared ?? "npm")
  const script = scripts[name]!
  // Frameworks read the port from different places; pass it every common way.
  const flags = /\b(vite|astro|nuxt|svelte-kit|next)\b/.test(script) ? ` -- --port ${port} --host 127.0.0.1` : ""
  const run = pm === "npm" ? `npm run ${name}` : `${pm} run ${name}`
  return {
    command: `${run}${pm === "npm" || pm === "pnpm" ? flags : flags.replace(" -- ", " ")}`,
    port,
    env: { PORT: String(port), HOST: "127.0.0.1", HOSTNAME: "127.0.0.1", BROWSER: "none", NODE_ENV: "development" },
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

export type Preview = { url: string; directory: string; stop: () => Promise<void>; output: () => string }

export async function startPreview(input: {
  directory: string
  contest: string
  slot: string
  setupTimeoutMs?: number
  readyTimeoutMs?: number
}): Promise<Preview> {
  const repo = await Git.repoRoot(input.directory)
  const ref = `refs/redrob/contest/${input.contest}/${input.slot}`
  const commit = await Git.resolve(repo, ref)
  const directory = path.join(worktreeRoot(), "preview", `${input.contest}-${input.slot}`)
  await Git.addWorktree(repo, directory, commit)
  const cleanup = () => Git.removeWorktree(repo, directory)
  try {
    const port = await freePort()
    const plan = previewCommand(directory, port)
    if (!plan) throw new Error("This project has no dev, start or preview script to run.")
    const setup = await runSetup(directory, detectProject(directory), input.setupTimeoutMs ?? 10 * 60_000)
    if (!setup.ok) throw new Error(`Installing dependencies failed:\n${setup.output}`)

    let output = ""
    const child: ChildProcess = spawn(plan.command, [], {
      cwd: directory,
      shell: true,
      env: { ...process.env, ...plan.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
    child.stdout?.on("data", (chunk) => (output = (output + String(chunk)).slice(-20_000)))
    child.stderr?.on("data", (chunk) => (output = (output + String(chunk)).slice(-20_000)))

    const stop = async () => {
      if (child.pid && child.exitCode === null) {
        if (process.platform === "win32")
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
        else {
          try {
            process.kill(-child.pid, "SIGTERM")
          } catch {}
        }
        await new Promise((done) => setTimeout(done, 500))
      }
      await cleanup()
    }

    const url = `http://127.0.0.1:${port}/`
    const deadline = Date.now() + (input.readyTimeoutMs ?? 120_000)
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        await stop()
        throw new Error(`The dev server exited (${child.exitCode}).\n${output.slice(-2000)}`)
      }
      const ok = await fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
        (response) => response.status < 500,
        () => false,
      )
      if (ok) return { url, directory, stop, output: () => output }
      await new Promise((done) => setTimeout(done, 500))
    }
    await stop()
    throw new Error(`The dev server did not answer on port ${port} in time.\n${output.slice(-2000)}`)
  } catch (error) {
    await cleanup().catch(() => {})
    throw error
  }
}
