import { spawn } from "node:child_process"

/**
 * Child processes for the contest, in plain Node so the same code runs inside the CLI (bun), the
 * desktop main process (Electron's Node) and tests.
 */

export type RunResult = { code: number; stdout: string; stderr: string; durationMs: number; timedOut: boolean }

const MAX_OUTPUT = 4_000_000

export function run(
  file: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; shell?: boolean; input?: string },
): Promise<RunResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      windowsHide: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      // Its own group on POSIX, so a timeout stops the test runner AND whatever it started.
      detached: process.platform !== "win32",
    })
    if (options.input !== undefined) child.stdin?.end(options.input)
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += String(chunk)
    })
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          stop(child.pid)
        }, options.timeoutMs)
      : undefined
    child.once("error", (error) => {
      if (timer) clearTimeout(timer)
      resolve({ code: 127, stdout, stderr: stderr + error.message, durationMs: Date.now() - started, timedOut })
    })
    child.once("close", (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? (timedOut ? 124 : 1), stdout, stderr, durationMs: Date.now() - started, timedOut })
    })
  })
}

function stop(pid: number | undefined) {
  if (!pid) return
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).once("error", () => {})
    return
  }
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
}

/** A shell command line, run the way a person would type it in this project. */
export function shell(command: string, cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv) {
  return run(command, [], { cwd, shell: true, timeoutMs, env: { ...process.env, CI: "1", ...env } })
}

export function tail(text: string, lines = 40) {
  return text.split(/\r?\n/).slice(-lines).join("\n")
}
