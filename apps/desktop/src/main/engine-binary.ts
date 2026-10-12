import path from "node:path"
import type { EngineSource } from "../shared/bridge"

/**
 * Where the engine binary comes from.
 *
 * The desktop app never needs the CLI to be installed: it ships its own copy of the engine inside its
 * resources and runs that by default. It never puts that copy on PATH or into the CLI's install
 * directory either, so a vanilla `install.sh` / `install.ps1` / `redrob-code-x64-setup.exe` install keeps
 * recognising itself and updating itself (`isCurlInstall` and `isWindowsInstallerInstall` in
 * packages/redrob/src/installation/index.ts both check the location).
 *
 * Pure: every input arrives as an argument, so the order can be tested on any platform.
 */

export type ResolveInput = {
  platform: NodeJS.Platform
  arch: string
  env: Record<string, string | undefined>
  home: string
  /** `process.resourcesPath` when packaged. */
  resourcesPath: string | null
  /** The repository root, when running unpackaged from a checkout. */
  repoRoot: string | null
  preferInstalledCli: boolean
  exists: (file: string) => boolean
}

export type Resolved = { binary: string; source: EngineSource }

/** The bundled engine's file name. On Windows it is `.bin` so electron-builder does not re-sign an exe the release already signed. */
export function bundledName(platform: NodeJS.Platform) {
  return platform === "win32" ? "redrob.bin" : "redrob"
}

/** The release build's directory name for this platform, as `packages/redrob/script/build.ts` writes it. */
export function releaseTarget(platform: NodeJS.Platform, arch: string) {
  const os = platform === "win32" ? "windows" : platform
  return `redrob-${os}-${arch}`
}

/**
 * Where the official installers put the CLI, in the order `install` and `install.ps1` choose them.
 * `install`: REDROB_INSTALL_DIR, XDG_BIN_DIR, ~/bin, ~/.redrob/bin. The Windows installer:
 * %LOCALAPPDATA%\Redrob\bin, or REDROB_CODE_INSTALL_DIR.
 */
export function cliCandidates(input: Pick<ResolveInput, "platform" | "env" | "home">): string[] {
  const { platform, env, home } = input
  const join = platform === "win32" ? path.win32.join : path.posix.join
  const exe = platform === "win32" ? "redrob.exe" : "redrob"
  const dirs: string[] = []
  if (platform === "win32") {
    if (env["REDROB_CODE_INSTALL_DIR"]) dirs.push(env["REDROB_CODE_INSTALL_DIR"])
    const local = env["LOCALAPPDATA"] ?? join(home, "AppData", "Local")
    dirs.push(join(local, "Redrob", "bin"))
  } else {
    if (env["REDROB_INSTALL_DIR"]) dirs.push(env["REDROB_INSTALL_DIR"])
    if (env["XDG_BIN_DIR"]) dirs.push(env["XDG_BIN_DIR"])
    dirs.push(join(home, "bin"), join(home, ".redrob", "bin"), join(home, ".local", "bin"))
  }
  const fromPath = (env["PATH"] ?? env["Path"] ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean)
  return [...new Set([...dirs, ...fromPath].map((dir) => join(dir, exe)))]
}

export function findCli(input: Pick<ResolveInput, "platform" | "env" | "home" | "exists">): string | null {
  return cliCandidates(input).find((file) => input.exists(file)) ?? null
}

export function resolveEngineBinary(input: ResolveInput): Resolved | null {
  const override = input.env["REDROB_CODE_BIN"]?.trim()
  if (override && input.exists(override)) return { binary: override, source: "override" }

  const cli = findCli(input)
  if (input.preferInstalledCli && cli) return { binary: cli, source: "cli" }

  const join = input.platform === "win32" ? path.win32.join : path.posix.join
  if (input.resourcesPath) {
    const bundled = join(input.resourcesPath, "engine", bundledName(input.platform))
    if (input.exists(bundled)) return { binary: bundled, source: "bundled" }
  }
  if (input.repoRoot) {
    const exe = input.platform === "win32" ? "redrob.exe" : "redrob"
    const local = join(
      input.repoRoot,
      "packages",
      "redrob",
      "dist",
      releaseTarget(input.platform, input.arch),
      "bin",
      exe,
    )
    if (input.exists(local)) return { binary: local, source: "bundled" }
  }

  if (cli) return { binary: cli, source: "cli" }
  return null
}
