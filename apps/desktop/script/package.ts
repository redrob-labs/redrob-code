#!/usr/bin/env bun
/**
 * Builds the interface and the main process, then packages them with electron-builder.
 *
 *   bun run package            installer for this platform
 *   bun run package --dir      unpacked app only (what CI smoke-tests)
 *
 * The engine must already be in resources/engine (`bun run prepare-engine`). Publishing is never done
 * here: the release workflow uploads the artifacts itself, next to the CLI's.
 */
import { $ } from "bun"
import { existsSync } from "node:fs"
import path from "node:path"
import { bundledName } from "../src/main/engine-binary"

const root = path.resolve(import.meta.dir, "..")
const args = process.argv.slice(2)
const version = process.env["REDROB_VERSION"] ?? "0.0.0"

if (!existsSync(path.join(root, "resources", "engine", bundledName(process.platform)))) {
  console.error("resources/engine is empty; run `bun run prepare-engine` first")
  process.exit(1)
}

await $`bun run --cwd ${path.join(root, "..", "studio")} build`
await $`bun run ${path.join(root, "script", "build.ts")}`.env({ ...process.env, REDROB_VERSION: version })

const builderArgs = [
  "--config",
  "electron-builder.config.mjs",
  "--publish",
  "never",
  `-c.extraMetadata.version=${version}`,
  ...(args.includes("--dir") ? ["--dir"] : []),
]
await $`bunx electron-builder ${builderArgs}`.cwd(root)
