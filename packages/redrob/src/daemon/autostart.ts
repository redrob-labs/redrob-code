/**
 * Start the shared daemon at login, so a chat channel keeps answering after a reboot.
 *
 * One registration per platform, all user-level (no root, no admin):
 *
 *   Linux    systemd user unit   ~/.config/systemd/user/redrob-engine.service
 *   macOS    launchd agent       ~/Library/LaunchAgents/ai.redrob.engine.plist
 *   Windows  Task Scheduler      task "Redrob Engine", trigger ONLOGON, via schtasks.exe
 *
 * The unit runs `redrob serve --register --idle-exit 0` with the binary that installed it, so the
 * daemon is the same build as the CLI. `redrob channels enable` installs it the first time a
 * channel is turned on and `redrob channels disable` removes it once no channel is left enabled,
 * so a machine that never uses a channel never gets a resident process. `redrob service
 * install|uninstall|status` are the by-hand versions.
 */
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { selfCommand } from "./connect"

export type Platform = "linux" | "darwin" | "win32"

export type State = {
  platform: Platform | "unsupported"
  installed: boolean
  /** The unit file (Linux/macOS) or the task name (Windows). */
  location: string
}

const SERVICE_NAME = "redrob-engine"
const LAUNCHD_LABEL = "ai.redrob.engine"
const TASK_NAME = "Redrob Engine"

function platform(): Platform | "unsupported" {
  const p = process.platform
  return p === "linux" || p === "darwin" || p === "win32" ? p : "unsupported"
}

export function location(env: NodeJS.ProcessEnv = process.env): string {
  switch (platform()) {
    case "linux":
      return path.join(env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"), "systemd", "user", `${SERVICE_NAME}.service`)
    case "darwin":
      return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
    case "win32":
      return TASK_NAME
    default:
      return ""
  }
}

/** The daemon's command line, as the unit will run it. */
export function daemonCommand(): { command: string; args: string[] } {
  const self = selfCommand()
  return { command: self.command, args: [...self.args, "serve", "--register", "--idle-exit", "0"] }
}

function run(command: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d.toString()))
    child.stderr.on("data", (d) => (stderr += d.toString()))
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: stderr + String(error) }))
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
    if (input !== undefined) child.stdin.write(input)
    child.stdin.end()
  })
}

const exists = (p: string) =>
  fs
    .stat(p)
    .then(() => true)
    .catch(() => false)

// ---- Linux: systemd --user -----------------------------------------------------------------

function systemdQuote(value: string): string {
  // systemd ExecStart: double-quote, escape backslash and double quote.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function systemdUnit(): string {
  const { command, args } = daemonCommand()
  const exec = [command, ...args].map(systemdQuote).join(" ")
  return [
    "[Unit]",
    "Description=Redrob Code engine (shared daemon for chat channels and apps)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${exec}`,
    "Restart=on-failure",
    "RestartSec=5",
    "Environment=REDROB_SERVICE=systemd",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")
}

async function installLinux(env: NodeJS.ProcessEnv): Promise<void> {
  const file = location(env)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, systemdUnit(), { mode: 0o644 })
  const reload = await run("systemctl", ["--user", "daemon-reload"])
  if (reload.code !== 0) throw new Error(`systemctl --user daemon-reload failed: ${reload.stderr.trim() || reload.code}`)
  const enable = await run("systemctl", ["--user", "enable", "--now", `${SERVICE_NAME}.service`])
  if (enable.code !== 0) throw new Error(`systemctl --user enable failed: ${enable.stderr.trim() || enable.code}`)
}

async function uninstallLinux(env: NodeJS.ProcessEnv): Promise<void> {
  const file = location(env)
  // Disable without --now: the running daemon stays up for the apps attached to it and exits on
  // its own idle policy once they go; only the login start goes away.
  await run("systemctl", ["--user", "disable", `${SERVICE_NAME}.service`])
  await fs.rm(file, { force: true })
  await run("systemctl", ["--user", "daemon-reload"])
}

// ---- macOS: launchd agent -------------------------------------------------------------------

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function launchdPlist(): string {
  const { command, args } = daemonCommand()
  const argv = [command, ...args].map((a) => `    <string>${xml(a)}</string>`).join("\n")
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    argv,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>REDROB_SERVICE</key>",
    "    <string>launchd</string>",
    "  </dict>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n")
}

async function installDarwin(env: NodeJS.ProcessEnv): Promise<void> {
  const file = location(env)
  await fs.mkdir(path.dirname(file), { recursive: true })
  // Unload an older copy first; launchctl refuses to load a label twice.
  if (await exists(file)) await run("launchctl", ["unload", file])
  await fs.writeFile(file, launchdPlist(), { mode: 0o644 })
  const load = await run("launchctl", ["load", "-w", file])
  if (load.code !== 0) throw new Error(`launchctl load failed: ${load.stderr.trim() || load.code}`)
}

async function uninstallDarwin(env: NodeJS.ProcessEnv): Promise<void> {
  const file = location(env)
  if (await exists(file)) await run("launchctl", ["unload", "-w", file])
  await fs.rm(file, { force: true })
}

// ---- Windows: Task Scheduler ----------------------------------------------------------------

function cmdQuote(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

async function installWin32(): Promise<void> {
  const { command, args } = daemonCommand()
  const tr = [command, ...args].map(cmdQuote).join(" ")
  // /F overwrites an existing task of the same name; /RL LIMITED = no elevation.
  const result = await run("schtasks.exe", ["/Create", "/F", "/SC", "ONLOGON", "/TN", TASK_NAME, "/TR", tr, "/RL", "LIMITED"])
  if (result.code !== 0) throw new Error(`schtasks /Create failed: ${result.stderr.trim() || result.stdout.trim() || result.code}`)
  // Start it now too, so the first enable does not wait for the next login.
  await run("schtasks.exe", ["/Run", "/TN", TASK_NAME])
}

async function uninstallWin32(): Promise<void> {
  // /Delete alone: the daemon the task started keeps running for attached apps.
  await run("schtasks.exe", ["/Delete", "/F", "/TN", TASK_NAME])
}

async function installedWin32(): Promise<boolean> {
  const result = await run("schtasks.exe", ["/Query", "/TN", TASK_NAME])
  return result.code === 0
}

// ---- public ---------------------------------------------------------------------------------

export async function status(env: NodeJS.ProcessEnv = process.env): Promise<State> {
  const p = platform()
  const loc = location(env)
  switch (p) {
    case "linux":
    case "darwin":
      return { platform: p, installed: await exists(loc), location: loc }
    case "win32":
      return { platform: p, installed: await installedWin32(), location: loc }
    default:
      return { platform: "unsupported", installed: false, location: "" }
  }
}

/** Register login start and start the daemon now. Idempotent: rewrites the unit each time. */
export async function install(env: NodeJS.ProcessEnv = process.env): Promise<State> {
  switch (platform()) {
    case "linux":
      await installLinux(env)
      break
    case "darwin":
      await installDarwin(env)
      break
    case "win32":
      await installWin32()
      break
    default:
      throw new Error(`Login start is not supported on ${process.platform}`)
  }
  return status(env)
}

/** Remove the login registration. Does nothing when none is installed. */
export async function uninstall(env: NodeJS.ProcessEnv = process.env): Promise<State> {
  switch (platform()) {
    case "linux":
      await uninstallLinux(env)
      break
    case "darwin":
      await uninstallDarwin(env)
      break
    case "win32":
      await uninstallWin32()
      break
    default:
      return { platform: "unsupported", installed: false, location: "" }
  }
  return status(env)
}

/**
 * Keep the registration in step with the channels config: installed while at least one channel
 * is enabled, removed when none is. Called by `redrob channels enable|disable`. Errors are
 * returned, not thrown, so a missing systemctl never blocks the config change itself.
 */
export async function sync(enabledCount: number, env: NodeJS.ProcessEnv = process.env): Promise<{ state: State; changed: boolean; error?: string }> {
  const before = await status(env)
  if (before.platform === "unsupported") return { state: before, changed: false }
  try {
    if (enabledCount > 0 && !before.installed) return { state: await install(env), changed: true }
    if (enabledCount === 0 && before.installed) return { state: await uninstall(env), changed: true }
    return { state: before, changed: false }
  } catch (error) {
    return { state: before, changed: false, error: error instanceof Error ? error.message : String(error) }
  }
}
