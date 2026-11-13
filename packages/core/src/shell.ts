export * as Shell from "./shell"

import path from "path"
import { execFileSync, spawn, type ChildProcess } from "child_process"
import { readFile } from "fs/promises"
import { statSync } from "fs"
import { setTimeout as sleep } from "node:timers/promises"
import { Flag } from "./flag/flag"
import { FSUtil } from "./fs-util"
import { which } from "./util/which"

const SIGKILL_TIMEOUT_MS = 200
const META: Record<string, { deny?: boolean; login?: boolean; posix?: boolean; ps?: boolean }> = {
  bash: { login: true, posix: true },
  dash: { login: true, posix: true },
  fish: { deny: true, login: true },
  ksh: { login: true, posix: true },
  nu: { deny: true },
  powershell: { ps: true },
  pwsh: { ps: true },
  sh: { login: true, posix: true },
  zsh: { login: true, posix: true },
}

export type Item = {
  path: string
  name: string
  acceptable: boolean
}

export async function killTree(proc: ChildProcess, opts?: { exited?: () => boolean }): Promise<void> {
  const pid = proc.pid
  if (!pid || opts?.exited?.()) return

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
        stdio: "ignore",
        windowsHide: true,
      })
      killer.once("exit", () => resolve())
      killer.once("error", () => resolve())
    })
    return
  }

  try {
    process.kill(-pid, "SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      process.kill(-pid, "SIGKILL")
    }
  } catch {
    proc.kill("SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      proc.kill("SIGKILL")
    }
  }
}

function stat(file: string) {
  return statSync(file, { throwIfNoEntry: false }) ?? undefined
}

function full(file: string) {
  if (process.platform !== "win32") return file
  const shell = FSUtil.windowsPath(file)
  if (path.win32.dirname(shell) !== ".") {
    if (shell.startsWith("/") && name(shell) === "bash") return gitbash() || shell
    return shell
  }
  if (name(shell) === "bash") return gitbash() || which(shell) || shell
  return which(shell) || shell
}

function meta(file: string) {
  return META[name(file)]
}

function ok(file: string) {
  return meta(file)?.deny !== true
}

function rooted(file: string) {
  return path.isAbsolute(FSUtil.windowsPath(file))
}

function resolve(file: string) {
  const shell = full(file)
  if (rooted(shell)) {
    if (stat(shell)?.isFile()) return shell
    return
  }
  return which(shell) ?? undefined
}

function win() {
  return Array.from(
    new Set(
      [which("pwsh"), which("powershell"), gitbash(), process.env.COMSPEC || "cmd.exe"]
        .filter((item): item is string => Boolean(item))
        .map(full),
    ),
  )
}

async function unix() {
  const text = await readFile("/etc/shells", "utf8").catch(() => "")
  if (text) return Array.from(new Set(text.split("\n").filter((line) => line.trim() && !line.startsWith("#"))))
  return ["/bin/bash", "/bin/zsh", "/bin/sh"]
}

function select(file: string | undefined, opts?: { acceptable?: boolean }) {
  if (file && (!opts?.acceptable || ok(file))) {
    const shell = resolve(file)
    if (shell) return shell
  }
  if (process.platform === "win32") return win()[0]
  return fallback()
}

export function gitbash() {
  if (process.platform !== "win32") return
  if (Flag.REDROB_GIT_BASH_PATH) return Flag.REDROB_GIT_BASH_PATH
  const git = which("git")
  if (!git) return
  const file = path.join(git, "..", "..", "bin", "bash.exe")
  if (stat(file)?.size) return file
}

function fallback() {
  if (process.platform === "darwin") return "/bin/zsh"
  const bash = which("bash")
  if (bash) return bash
  return "/bin/sh"
}

export function name(file: string) {
  if (process.platform === "win32") return path.win32.parse(FSUtil.windowsPath(file)).name.toLowerCase()
  return path.basename(file).toLowerCase()
}

export function login(file: string) {
  return meta(file)?.login === true
}

export function posix(file: string) {
  return meta(file)?.posix === true
}

export function ps(file: string) {
  return meta(file)?.ps === true
}

function info(file: string): Item {
  const item = full(file)
  const n = name(item)
  return {
    path: item,
    name: resolve(n) ? n : item,
    acceptable: ok(item),
  }
}

export function args(file: string, command: string, cwd: string) {
  const n = name(file)
  if (n === "nu" || n === "fish") return ["-c", command]
  if (n === "zsh") {
    return [
      "-l",
      "-c",
      `
        [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
        [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
        cd -- "$1"
        eval ${JSON.stringify(command)}
      `,
      "redrob",
      cwd,
    ]
  }
  if (n === "bash") {
    return [
      "-l",
      "-c",
      `
        shopt -s expand_aliases
        [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
        cd -- "$1"
        eval ${JSON.stringify(command)}
      `,
      "redrob",
      cwd,
    ]
  }
  if (n === "cmd") return ["/c", command]
  if (ps(file)) return ["-NoProfile", "-Command", command]
  return ["-c", command]
}

let defaultPreferred: string | undefined
let defaultAcceptable: string | undefined

export function preferred(configShell?: string) {
  if (configShell) return select(configShell)
  defaultPreferred ??= select(process.env.SHELL)
  return defaultPreferred
}
preferred.reset = () => {
  defaultPreferred = undefined
}

export function acceptable(configShell?: string) {
  if (configShell) return select(configShell, { acceptable: true })
  defaultAcceptable ??= select(process.env.SHELL, { acceptable: true })
  return defaultAcceptable
}
acceptable.reset = () => {
  defaultAcceptable = undefined
}

export async function list(): Promise<Item[]> {
  const shells = process.platform === "win32" ? win() : await unix()
  return shells.filter((s) => resolve(s)).map(info)
}

// Windows console programs write in the console or ANSI code page (949 on Korean Windows), and we
// decode their output as UTF-8. Ask the shell and Python for UTF-8 up front, and decode whatever
// still arrives as non-UTF-8 with the system code page instead of turning it into U+FFFD.

/** Child env defaults that make Python write UTF-8 to a pipe. The caller's own values win. */
export function env(platform = process.platform): Record<string, string> {
  if (platform !== "win32") return {}
  return { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
}

/** Prefix a Windows command so PowerShell and cmd write UTF-8. */
export function utf8(file: string, command: string, platform = process.platform) {
  if (platform !== "win32") return command
  if (ps(file)) return `[Console]::OutputEncoding=$OutputEncoding=[Text.UTF8Encoding]::new($false);${command}`
  if (name(file) === "cmd") return `chcp 65001>nul&${command}`
  return command
}

let acp: number | undefined | null = null

/** The system ANSI code page, read once from the registry. */
function codepage() {
  if (acp !== null) return acp
  acp = undefined
  try {
    const text = execFileSync("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage", "/v", "ACP"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2000,
    })
    const match = /ACP\s+REG_SZ\s+(\d+)/.exec(text)
    if (match) acp = Number(match[1])
  } catch {}
  return acp
}

const LABELS: Record<number, string> = { 866: "ibm866", 932: "shift_jis", 936: "gbk", 949: "euc-kr", 950: "big5" }

function legacy(page: number | undefined) {
  if (page && page !== 65001) {
    try {
      return new TextDecoder((LABELS[page] ?? `windows-${page}`) as ConstructorParameters<typeof TextDecoder>[0])
    } catch {}
  }
  return new TextDecoder("utf-8")
}

// Trailing bytes that open a UTF-8 sequence the chunk does not finish; the decoder holds them back.
function pending(bytes: Uint8Array) {
  for (let i = 1; i <= Math.min(3, bytes.length); i++) {
    const byte = bytes[bytes.length - i]
    if ((byte & 0xc0) === 0x80) continue
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    return need > i ? bytes.slice(bytes.length - i) : new Uint8Array()
  }
  return new Uint8Array()
}

/**
 * A streaming decoder for shell output. UTF-8 everywhere; on Windows, once the output turns out not
 * to be UTF-8, the rest of the stream is decoded with the system code page.
 */
export function decoder(platform = process.platform, page: () => number | undefined = codepage) {
  const text = new TextDecoder("utf-8", { fatal: platform === "win32" })
  let fallback: TextDecoder | undefined
  let tail = new Uint8Array()
  return (bytes: Uint8Array) => {
    if (fallback) return fallback.decode(bytes, { stream: true })
    try {
      const out = text.decode(bytes, { stream: true })
      tail = pending(bytes)
      return out
    } catch {
      fallback = legacy(page())
      const all = new Uint8Array(tail.length + bytes.length)
      all.set(tail)
      all.set(bytes, tail.length)
      return fallback.decode(all, { stream: true })
    }
  }
}
