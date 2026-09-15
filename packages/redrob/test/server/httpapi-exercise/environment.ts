import { Flag } from "@redrob-code/core/flag/flag"
import { Effect } from "effect"
import path from "path"

const preserveExerciseGlobalRoot = !!process.env.REDROB_HTTPAPI_EXERCISE_GLOBAL
export const exerciseGlobalRoot =
  process.env.REDROB_HTTPAPI_EXERCISE_GLOBAL ??
  path.join(process.env.TMPDIR ?? "/tmp", `redrob-httpapi-global-${process.pid}`)
process.env.XDG_DATA_HOME = path.join(exerciseGlobalRoot, "data")
process.env.XDG_CONFIG_HOME = path.join(exerciseGlobalRoot, "config")
process.env.XDG_STATE_HOME = path.join(exerciseGlobalRoot, "state")
process.env.XDG_CACHE_HOME = path.join(exerciseGlobalRoot, "cache")
process.env.REDROB_DISABLE_SHARE = "true"
export const exerciseConfigDirectory = path.join(exerciseGlobalRoot, "config", "redrob")
export const exerciseDataDirectory = path.join(exerciseGlobalRoot, "data", "redrob")

const preserveExerciseDatabase = !!process.env.REDROB_HTTPAPI_EXERCISE_DB
export const exerciseDatabasePath =
  process.env.REDROB_HTTPAPI_EXERCISE_DB ??
  path.join(process.env.TMPDIR ?? "/tmp", `redrob-httpapi-exercise-${process.pid}.db`)
process.env.REDROB_DB = exerciseDatabasePath
Flag.REDROB_DB = exerciseDatabasePath

export const original = {
  REDROB_SERVER_PASSWORD: Flag.REDROB_SERVER_PASSWORD,
  REDROB_SERVER_USERNAME: Flag.REDROB_SERVER_USERNAME,
}

export const cleanupExercisePaths = Effect.promise(async () => {
  const fs = await import("fs/promises")
  if (!preserveExerciseDatabase) {
    await Promise.all(
      [exerciseDatabasePath, `${exerciseDatabasePath}-wal`, `${exerciseDatabasePath}-shm`].map((file) =>
        fs.rm(file, { force: true }).catch(() => undefined),
      ),
    )
  }
  if (!preserveExerciseGlobalRoot)
    await fs.rm(exerciseGlobalRoot, { recursive: true, force: true }).catch(() => undefined)
})
