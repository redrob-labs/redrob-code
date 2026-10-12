#!/usr/bin/env bun
/**
 * Launches the unpacked, packaged app with `--smoke-test` and fails unless it exits 0.
 *
 * The app then starts the bundled engine exactly as an installed copy would, proves it answers an
 * authenticated health check and refuses an unauthenticated one, and quits. That is the minimum a
 * release must prove before an installer is published.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"

const dist = path.resolve(import.meta.dir, "..", "dist")
const candidates: string[] = []
if (process.platform === "win32") candidates.push(path.join(dist, "win-unpacked", "redrob-code-desktop.exe"))
if (process.platform === "linux") {
  for (const dir of readdirSync(dist).filter((name) => name.startsWith("linux") && name.endsWith("unpacked")))
    candidates.push(path.join(dist, dir, "redrob-code-desktop"))
}
if (process.platform === "darwin") {
  for (const dir of readdirSync(dist).filter((name) => name.startsWith("mac")))
    candidates.push(path.join(dist, dir, "Redrob Code.app", "Contents", "MacOS", "Redrob Code"))
}
const app = candidates.find((file) => existsSync(file))
if (!app) {
  console.error(`no packaged app under ${dist}; run \`bun run package --dir\` first`)
  process.exit(1)
}

// CI runners have no display; the smoke test opens no window, so Electron runs headless there.
const extra = process.platform === "linux" ? ["--no-sandbox", "--disable-gpu", "--ozone-platform=headless"] : []
const result = spawnSync(app, ["--smoke-test", ...extra], { stdio: "inherit", timeout: 120_000 })
if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
