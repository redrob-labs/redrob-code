#!/usr/bin/env bun
/**
 * Release assets in the shape Redrob Launcher installs from.
 *
 * The launcher reads a release's asset list and installs only names of the form
 *
 *     <stem>-<version>-<os>-<arch>[-portable].<ext>
 *
 * where the stem is this repository's name, the version carries no `v`, and the os-arch token
 * is one of a fixed set (`linux-x86_64`, not `linux-x64`; `macos-aarch64`, not `darwin-arm64`).
 * The build names its outputs after Bun's targets (`redrob-linux-x64`, `redrob-darwin-arm64`),
 * which the launcher cannot parse, so nothing here was installable from it.
 *
 * The build's own names STAY. `install.sh`, `install.ps1`, `redrob upgrade`
 * (`src/installation/index.ts`), the Homebrew and AUR definitions in `publish.ts` and the
 * Dockerfile all download `redrob-<os>-<arch>.<ext>` by that exact name, so renaming would break
 * every existing install's self-update. The launcher assets are ADDITIONAL copies, one per
 * platform the launcher has a token for -- the baseline and musl variants have no launcher
 * token and are not duplicated.
 *
 * Linux tarballs are repacked rather than copied: the launcher unpacks a tarball into
 * `<top>/bin/<app-id>` and looks for the binary under the app's id, `redrob-code`, so the
 * launcher tarball carries `bin/redrob-code` with `bin/redrob` beside it as a symlink -- the
 * same two names `install.sh` creates. macOS and Windows archives are byte-for-byte copies of
 * the signed zips: the binary inside is what was notarized or Authenticode-signed, and
 * re-archiving it would gain nothing.
 *
 * Usage (from the release workflow's publish job):
 *
 *     launcher-assets.ts --version 0.5.1 --unsigned unsigned --signed assets --out assets
 *
 * `--unsigned` is the build artifact (`redrob-<os>-<arch>/bin/redrob` directories); `--signed`
 * holds the signed macOS and Windows zips; `--out` receives the launcher assets. Exits non-zero
 * if any expected input is missing, so a release cannot quietly ship without a platform.
 *
 * Beside the installers it writes `redrob-launcher.json`, the release manifest the launcher reads
 * to learn that this release uses the launcher's shared account (`packages/core/src/shared-account.ts`),
 * and `verifyReleaseDirectory` refuses a release directory that lacks it or carries a wrong one.
 */
import fs from "node:fs"
import path from "node:path"
import { $ } from "bun"

/** The stem Redrob Launcher expects for this app: the repository name. */
export const STEM = "redrob-code"

/**
 * The release manifest the launcher reads beside the installers (the launcher's
 * `docs/release-manifest.md`). `schema` is 1; `sharedAccount` is true because every release from
 * here on reads the launcher's shared account file as its last console-key fallback.
 */
export const MANIFEST_NAME = "redrob-launcher.json"
export const MANIFEST = { schema: 1, sharedAccount: true } as const

/** The manifest's bytes, exactly as the launcher contract spells them, newline-terminated. */
export function manifestText(): string {
  return `{ "schema": ${MANIFEST.schema}, "sharedAccount": ${MANIFEST.sharedAccount} }\n`
}

/** Writes the manifest into `out` and returns its path. */
export function writeManifest(out: string): string {
  fs.mkdirSync(out, { recursive: true })
  const dest = path.join(out, MANIFEST_NAME)
  fs.writeFileSync(dest, manifestText())
  return dest
}

/**
 * Checks a release directory is one the launcher can use: every launcher installer for `version`
 * is present and `redrob-launcher.json` exists, is JSON, is schema 1 and says `sharedAccount: true`.
 * Returns the problems found, empty when the directory passes.
 */
export function verifyReleaseDirectory(dir: string, version: string): string[] {
  const problems: string[] = []
  for (const name of expectedLauncherAssets(version)) {
    if (!fs.existsSync(path.join(dir, name))) problems.push(`missing launcher asset ${name}`)
  }
  const manifest = path.join(dir, MANIFEST_NAME)
  if (!fs.existsSync(manifest)) {
    problems.push(`missing ${MANIFEST_NAME}`)
    return problems
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(manifest, "utf8"))
  } catch (error) {
    problems.push(`${MANIFEST_NAME} is not JSON: ${error instanceof Error ? error.message : String(error)}`)
    return problems
  }
  const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>
  if (record.schema !== MANIFEST.schema)
    problems.push(`${MANIFEST_NAME} schema is ${JSON.stringify(record.schema)}, expected ${MANIFEST.schema}`)
  if (record.sharedAccount !== MANIFEST.sharedAccount)
    problems.push(
      `${MANIFEST_NAME} sharedAccount is ${JSON.stringify(record.sharedAccount)}, expected ${MANIFEST.sharedAccount}`,
    )
  return problems
}

/**
 * Build output directory -> launcher os-arch token. Only the variants the launcher has a token
 * for; see `Platform::tokens` in the launcher's `crates/core/src/platform.rs`.
 */
export const TARGETS: Record<string, { token: string; kind: "tar.gz" | "portable.zip" }> = {
  "redrob-linux-x64": { token: "linux-x86_64", kind: "tar.gz" },
  "redrob-linux-arm64": { token: "linux-aarch64", kind: "tar.gz" },
  "redrob-darwin-arm64": { token: "macos-aarch64", kind: "portable.zip" },
  "redrob-darwin-x64": { token: "macos-x86_64", kind: "portable.zip" },
  "redrob-windows-x64": { token: "windows-x64", kind: "portable.zip" },
  "redrob-windows-arm64": { token: "windows-arm64", kind: "portable.zip" },
}

/** The os-arch tokens the launcher parses, verbatim from `Platform::tokens`. */
export const LAUNCHER_TOKENS = new Set([
  "linux-x86_64",
  "linux-aarch64",
  "linux-riscv64",
  "macos-universal",
  "macos-aarch64",
  "macos-x86_64",
  "windows-x64",
  "windows-arm64",
  "windows-x86",
  "freebsd-x86_64",
])

/** The package suffixes the launcher installs, verbatim from `PackageKind::suffix`. */
export const LAUNCHER_SUFFIXES = ["-portable.zip", ".tar.gz", ".msi", ".dmg", ".AppImage", ".deb", ".rpm", ".flatpak"]

/** `<stem>-<version>-<token>.<ext>` for one build output. */
export function launcherAssetName(version: string, token: string, kind: "tar.gz" | "portable.zip") {
  return `${STEM}-${version}-${token}${kind === "tar.gz" ? ".tar.gz" : "-portable.zip"}`
}

/** Every launcher asset a release of `version` must carry. */
export function expectedLauncherAssets(version: string) {
  return Object.values(TARGETS).map((t) => launcherAssetName(version, t.token, t.kind))
}

/**
 * Whether the launcher would parse `name`. Mirrors `parse_asset_name` in the launcher: strip a
 * known suffix, strip the stem, then split the rest from the right into arch, os and version,
 * and require a version that starts with a digit and a token the launcher knows.
 */
export function isLauncherAssetName(name: string, stem = STEM): boolean {
  const suffix = LAUNCHER_SUFFIXES.find((s) => name.endsWith(s))
  if (!suffix) return false
  const base = name.slice(0, -suffix.length)
  if (!base.startsWith(stem + "-")) return false
  const rest = base.slice(stem.length + 1)
  const parts = rest.split("-")
  if (parts.length < 3) return false
  const arch = parts.pop()!
  const os = parts.pop()!
  const version = parts.join("-")
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) return false
  return LAUNCHER_TOKENS.has(`${os}-${arch}`)
}

export interface Inputs {
  version: string
  unsigned: string
  signed: string
  out: string
}

/**
 * Produces every launcher asset into `out`, then the manifest. Returns the installer names
 * written, in TARGETS order; the manifest is not an installer and is not among them.
 */
export async function pack(inputs: Inputs): Promise<string[]> {
  const written: string[] = []
  fs.mkdirSync(inputs.out, { recursive: true })
  for (const [dir, target] of Object.entries(TARGETS)) {
    const name = launcherAssetName(inputs.version, target.token, target.kind)
    const dest = path.join(inputs.out, name)
    if (target.kind === "tar.gz") {
      const binary = path.join(inputs.unsigned, dir, "bin", "redrob")
      if (!fs.existsSync(binary)) throw new Error(`missing build output ${binary}`)
      // Top folder named like the asset, as the launcher's own fixtures lay it out.
      const top = name.slice(0, -".tar.gz".length)
      const staging = fs.mkdtempSync(path.join(inputs.out, ".launcher-"))
      try {
        const bin = path.join(staging, top, "bin")
        fs.mkdirSync(bin, { recursive: true })
        fs.copyFileSync(binary, path.join(bin, STEM))
        fs.chmodSync(path.join(bin, STEM), 0o755)
        fs.symlinkSync(STEM, path.join(bin, "redrob"))
        await $`tar -czf ${path.resolve(dest)} ${top}`.cwd(staging)
      } finally {
        fs.rmSync(staging, { recursive: true, force: true })
      }
    } else {
      const zip = path.join(inputs.signed, `${dir}.zip`)
      if (!fs.existsSync(zip)) throw new Error(`missing signed archive ${zip}`)
      fs.copyFileSync(zip, dest)
    }
    written.push(name)
  }
  writeManifest(inputs.out)
  return written
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1 || !process.argv[i + 1]) throw new Error(`--${name} is required`)
  return process.argv[i + 1]
}

if (import.meta.main) {
  const inputs: Inputs = { version: arg("version"), unsigned: arg("unsigned"), signed: arg("signed"), out: arg("out") }
  if (!/^\d/.test(inputs.version)) throw new Error(`version must not carry a leading v: ${inputs.version}`)
  const names = await pack(inputs)
  for (const name of names) {
    if (!isLauncherAssetName(name)) throw new Error(`produced a name the launcher cannot parse: ${name}`)
    console.log(name)
  }
  console.log(MANIFEST_NAME)
  const problems = verifyReleaseDirectory(inputs.out, inputs.version)
  if (problems.length)
    throw new Error(`release directory ${inputs.out} is not launcher-ready:\n  ${problems.join("\n  ")}`)
}
