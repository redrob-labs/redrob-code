/**
 * Redrob Drive's tray icon (crates/tray): the one thing a Drive person sees on the computer. It
 * shows whether this computer is connected to Redrob Chat and offers open chat, open the shared
 * folder, pause / resume and close.
 *
 * The release puts `redrob-tray` next to `redrob` in every desktop archive and in the Windows
 * installers. An install that copied only `redrob` (the install scripts, an older installer) gets
 * it here on first use: the same release's platform archive, checked against SHA256SUMS.txt.
 *
 * Login start, one per platform, all user-level (as daemon/autostart.ts):
 *
 *   Windows  HKCU\Software\Microsoft\Windows\CurrentVersion\Run  value "Redrob Drive"
 *   macOS    ~/Library/LaunchAgents/ai.redrob.drive.plist
 *   Linux    ~/.config/autostart/redrob-drive.desktop
 *
 * The tray keeps one instance itself and writes its pid to `~/.redrob/run/tray.pid`, which
 * `stop()` reads.
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { InstallationVersion } from "@redrob-code/core/installation/version"
import { RELEASE_DOWNLOAD_BASE } from "@/installation"
import { endpoints } from "@/desk/auth"

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"
const RUN_VALUE = "Redrob Drive"
const LAUNCHD_LABEL = "ai.redrob.drive"

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name)

/** Where the tray lives: beside this very binary. */
export function trayPath(): string {
  return path.join(path.dirname(process.execPath), exe("redrob-tray"))
}

/** The Redrob Chat web app the tray opens: dev when the daemon targets the dev chat API. */
export function chatWebUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.REDROB_CHAT_WEB_URL?.trim()
  if (override) return override.replace(/\/+$/, "")
  const dev = new URL(endpoints(env).chatApi).hostname.split(/[.-]/).includes("dev")
  return dev ? "https://dev.redrob.ai" : "https://chat.redrob.ai"
}

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true })
    child.on("error", () => resolve(127))
    child.on("close", (code) => resolve(code ?? 1))
  })
}

const exists = (p: string) =>
  fs
    .stat(p)
    .then(() => true)
    .catch(() => false)

/** The release archive that carries this platform's tray, as the release names it. */
function archiveName(): string | undefined {
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : undefined
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : undefined
  if (!os || !arch) return undefined
  return `redrob-${os}-${arch}.${os === "linux" ? "tar.gz" : "zip"}`
}

/**
 * Fetch the tray from this version's release when it is not installed yet. Verified against the
 * release's SHA256SUMS.txt before anything is unpacked. Returns false when it cannot be had (a
 * local build, no network, a platform without a tray).
 */
async function download(target: string): Promise<boolean> {
  const name = archiveName()
  if (!name || InstallationVersion === "local") return false
  const base = `${RELEASE_DOWNLOAD_BASE}/download/v${InstallationVersion}`
  try {
    const sums = await fetch(`${base}/SHA256SUMS.txt`, { signal: AbortSignal.timeout(30_000) })
    if (!sums.ok) return false
    const line = (await sums.text()).split("\n").find((l) => l.trim().endsWith(` ${name}`) || l.trim().endsWith(`*${name}`))
    const expected = line?.trim().split(/\s+/)[0]?.toLowerCase()
    if (!expected) return false
    const response = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(300_000) })
    if (!response.ok) return false
    const bytes = Buffer.from(await response.arrayBuffer())
    if (createHash("sha256").update(bytes).digest("hex") !== expected) return false

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "redrob-tray-"))
    try {
      const archive = path.join(dir, name)
      await fs.writeFile(archive, bytes)
      const out = path.join(dir, "out")
      await fs.mkdir(out)
      // Windows 10+ ships bsdtar, which reads zip; macOS has unzip; Linux gets the tar.gz.
      const code =
        process.platform === "darwin"
          ? await run("unzip", ["-q", "-o", archive, "-d", out])
          : process.platform === "win32"
            ? await run("tar.exe", ["-xf", archive, "-C", out])
            : await run("tar", ["-xzf", archive, "-C", out])
      const unpacked = path.join(out, exe("redrob-tray"))
      if (code !== 0 || !(await exists(unpacked))) return false
      await fs.copyFile(unpacked, target)
      if (process.platform !== "win32") await fs.chmod(target, 0o755)
      return true
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  } catch {
    return false
  }
}

/** The tray binary, fetched first when this install does not have it. */
export async function ensure(): Promise<string | undefined> {
  const target = trayPath()
  if (await exists(target)) return target
  return (await download(target)) ? target : undefined
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Register the tray to start at login. Never throws; false when it could not be registered. */
export async function register(tray: string, chat: string): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const line = `"${tray}" --chat ${chat}`
      return (await run("reg.exe", ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", line, "/f"])) === 0
    }
    if (process.platform === "darwin") {
      const file = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
      const plist = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        "  <key>Label</key>",
        `  <string>${LAUNCHD_LABEL}</string>`,
        "  <key>ProgramArguments</key>",
        "  <array>",
        `    <string>${xml(tray)}</string>`,
        "    <string>--chat</string>",
        `    <string>${xml(chat)}</string>`,
        "  </array>",
        "  <key>RunAtLoad</key>",
        "  <true/>",
        "  <key>LimitLoadToSessionType</key>",
        "  <string>Aqua</string>",
        "  <key>ProcessType</key>",
        "  <string>Interactive</string>",
        "</dict>",
        "</plist>",
        "",
      ].join("\n")
      await fs.mkdir(path.dirname(file), { recursive: true })
      if (await exists(file)) await run("launchctl", ["unload", file])
      await fs.writeFile(file, plist, { mode: 0o644 })
      return (await run("launchctl", ["load", "-w", file])) === 0
    }
    if (process.platform === "linux") {
      const dir = path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"), "autostart")
      const entry = [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Redrob Drive",
        "Name[ko]=레드롭 드라이브",
        `Exec="${tray}" --chat ${chat}`,
        "X-GNOME-Autostart-enabled=true",
        "NoDisplay=true",
        "",
      ].join("\n")
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, "redrob-drive.desktop"), entry, { mode: 0o644 })
      return true
    }
  } catch {
    return false
  }
  return false
}

/** Remove the login start. Never throws. */
export async function unregister(): Promise<void> {
  try {
    if (process.platform === "win32") {
      await run("reg.exe", ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])
    } else if (process.platform === "darwin") {
      const file = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
      if (await exists(file)) await run("launchctl", ["unload", "-w", file])
      await fs.rm(file, { force: true })
    } else if (process.platform === "linux") {
      const dir = path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"), "autostart")
      await fs.rm(path.join(dir, "redrob-drive.desktop"), { force: true })
    }
  } catch {
    // Nothing registered, or not ours to remove.
  }
}

/** Start the tray now, detached; a running one stays and this one leaves (single instance). */
export function start(tray: string, chat: string): void {
  try {
    const child = spawn(tray, ["--chat", chat], { detached: true, stdio: "ignore", windowsHide: true })
    child.on("error", () => undefined)
    child.unref()
  } catch {
    // The tray is a convenience; Drive works without it.
  }
}

function pidFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.REDROB_RUN_DIR?.trim() || path.join(os.homedir(), ".redrob", "run"), "tray.pid")
}

/** Close the running tray, if any. */
export async function stop(): Promise<void> {
  const text = await fs.readFile(pidFile(), "utf8").catch(() => "")
  const pid = Number.parseInt(text.trim(), 10)
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid)
    } catch {
      // Already gone.
    }
  }
  await fs.rm(pidFile(), { force: true }).catch(() => undefined)
}
