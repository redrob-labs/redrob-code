#!/usr/bin/env bun
/**
 * Puts the engine binary where the packaged app looks for it: `resources/engine/redrob` (or
 * `redrob.bin` on Windows, so electron-builder does not sign a second time an exe the release already
 * signed).
 *
 * The source is, in order: `--from <file>`, `REDROB_CODE_ENGINE`, or this checkout's own release build
 * at packages/redrob/dist/redrob-<os>-<arch>/bin. The release workflow passes the SIGNED binary with
 * `--from`, so the engine inside the app is byte-for-byte the one published for the CLI.
 */
import { chmod, copyFile, mkdir, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { bundledName, releaseTarget } from "../src/main/engine-binary"

const root = path.resolve(import.meta.dir, "..")
const repo = path.resolve(root, "..", "..")
const argv = process.argv.slice(2)
const flag = (name: string) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const platform = (flag("--platform") ?? process.platform) as NodeJS.Platform
const arch = flag("--arch") ?? process.arch
const exe = platform === "win32" ? "redrob.exe" : "redrob"
const source =
  flag("--from") ??
  process.env["REDROB_CODE_ENGINE"] ??
  path.join(repo, "packages", "redrob", "dist", releaseTarget(platform, arch), "bin", exe)

if (!existsSync(source)) {
  console.error(`no engine binary at ${source}`)
  console.error("build one with `bun run --cwd packages/redrob build --single`, or pass --from <file>")
  process.exit(1)
}

const target = path.join(root, "resources", "engine")
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
const destination = path.join(target, bundledName(platform))
await copyFile(source, destination)
if (platform !== "win32") await chmod(destination, 0o755)
console.log(`engine: ${source} -> ${path.relative(root, destination)}`)
