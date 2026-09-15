export * as ConfigPaths from "./paths"

import path from "path"
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

// Config folder names searched while walking up from the cwd. `.opencode` is the legacy
// name and is listed first so a co-located `.redrob` folder wins the merge.
const DIRECTORY_NAMES = [".opencode", ".redrob"]

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
