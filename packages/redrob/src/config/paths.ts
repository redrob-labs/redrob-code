export * as ConfigPaths from "./paths"

import path from "path"
import { createHash } from "crypto"
import { Flag } from "@redrob-code/core/flag/flag"
import { Global } from "@redrob-code/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@redrob-code/core/fs-util"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

// Config folder name searched while walking up from the cwd.
const DIRECTORY_NAMES = [".redrob"]

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  return unique([
    Global.Path.config,
    ...(!Flag.REDROB_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: DIRECTORY_NAMES,
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets: DIRECTORY_NAMES,
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(Flag.REDROB_CONFIG_DIR ? [Flag.REDROB_CONFIG_DIR] : []),
  ])
})

// True for the per-project config folders (and REDROB_CONFIG_DIR) that hold `<name>.json`
// files. `directories` also returns the global config dir, which callers read separately.
export function isProjectDirectory(dir: string) {
  return DIRECTORY_NAMES.some((name) => dir.endsWith(name)) || dir === Flag.REDROB_CONFIG_DIR
}

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}

/**
 * Stable key for a project directory: the absolute, normalised path (lower-cased on Windows,
 * where the filesystem is case-insensitive) hashed with SHA-256. Apps compute the same key to
 * find `directoryConfigDir` without asking the engine.
 */
export function directoryKey(directory: string) {
  let resolved = path.resolve(directory).replace(/[\\/]+$/, "")
  if (process.platform === "win32") resolved = resolved.toLowerCase()
  return createHash("sha256").update(resolved).digest("hex")
}

/**
 * Per-directory config written by an app on top of the engine (Redrob Cowork writes its
 * workspace agents, plugins and MCP servers here), kept OUT of the project tree so it never
 * collides with the user's own `.redrob/redrob.json` and never shows up in git. One shared
 * daemon serves many apps and many directories, so this replaces the per-process
 * REDROB_CONFIG an app used to pass to an engine it spawned itself. Loaded with the same
 * precedence as REDROB_CONFIG: after the global config, before the project's own files.
 */
export function directoryConfigDir(directory: string) {
  return path.join(Global.Path.state, "directories", directoryKey(directory))
}
