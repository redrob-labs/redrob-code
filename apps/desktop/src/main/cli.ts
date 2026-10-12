import { execFile, spawn } from "node:child_process"
import type { CliStatus } from "../shared/bridge"

/**
 * The vanilla CLI, seen from the desktop app.
 *
 * The app only ever LOOKS for the CLI and, when asked, runs the OFFICIAL installer -- the same
 * command the README and the Console's /code page give. It never copies its own engine onto PATH, so
 * what that button produces is an ordinary CLI install that updates itself with `redrob upgrade`,
 * indistinguishable from one done in a terminal.
 */

export const INSTALL_SH = "https://console.redrob.ai/code/install.sh"
export const INSTALL_PS1 = "https://console.redrob.ai/code/install.ps1"

export function installCommand(platform: NodeJS.Platform): { display: string; file: string; args: string[] } {
  if (platform === "win32") {
    const script = `irm ${INSTALL_PS1} | iex`
    return {
      display: script,
      file: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    }
  }
  const script = `curl -fsSL ${INSTALL_SH} | sh`
  return { display: script, file: "/bin/sh", args: ["-c", script] }
}

export function cliVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: 10_000, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      if (error) return resolve(null)
      const match = /\d+\.\d+\.\d+\S*/.exec(stdout)
      resolve(match?.[0] ?? (stdout.trim() || null))
    })
  })
}

export async function cliStatus(found: string | null, platform: NodeJS.Platform): Promise<CliStatus> {
  return {
    installed: found !== null,
    path: found,
    version: found ? await cliVersion(found) : null,
    installCommand: installCommand(platform).display,
  }
}

export function runInstaller(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; output: string }> {
  const command = installCommand(platform)
  return new Promise((resolve) => {
    let output = ""
    const child = spawn(command.file, command.args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout?.on("data", (chunk) => (output += String(chunk)))
    child.stderr?.on("data", (chunk) => (output += String(chunk)))
    child.once("error", (error) => resolve({ ok: false, output: `${output}\n${error.message}` }))
    child.once("exit", (code) => resolve({ ok: code === 0, output }))
  })
}
