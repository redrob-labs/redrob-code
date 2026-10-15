export * as LocalGpuProbe from "./local-gpu-probe"

/**
 * Reading the GPU, where the platform lets us.
 *
 * Split from `local-model-fit` on purpose. The fit judgement is pure and testable with no
 * machine at all; this part shells out, and what it can learn differs per platform and per
 * driver. Keeping them apart means the verdict logic is never untestable because the probe
 * is.
 *
 * THE ONLY RULE THAT MATTERS HERE: a probe that cannot see a GPU returns `undefined`, which
 * the fit module reads as NOT MEASURED. It never returns "no GPU". Telling a user with a
 * discrete card that their machine has none is a false statement about their own computer,
 * and it is the statement they would push back on hardest and be right about.
 */

import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess, requireSuccess } from "../../process"

/** What a probe can learn. `vramBytes` is absent when the platform reports a name but no size. */
export type Gpu = { readonly name: string; readonly vramBytes?: number | undefined }

/** Short, because this runs on a path a user is waiting on and a wedged driver tool must not hold it. */
const PROBE_TIMEOUT = "3 seconds"

const MiB = 1024 * 1024

/**
 * The per-platform command and how to read it. Exported so the parsers are testable against
 * recorded tool output without a GPU, a driver, or that platform.
 *
 * Each is a listing command with machine-readable output, chosen over the prettier
 * human-facing variants so the parse does not depend on column widths.
 */
export const PROBES: ReadonlyArray<{
  readonly platforms: ReadonlyArray<string>
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly parse: (stdout: string) => Gpu | undefined
}> = [
  {
    // NVIDIA, any platform it is installed on. CSV without units keeps the parse trivial.
    platforms: ["linux", "win32", "darwin"],
    command: "nvidia-smi",
    args: ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
    parse: (stdout) => {
      const line = stdout.split("\n").find((candidate) => candidate.trim().length > 0)
      if (line === undefined) return undefined
      const [name, memory] = line.split(",").map((field) => field.trim())
      if (name === undefined || name.length === 0) return undefined
      const megabytes = Number(memory)
      return { name, vramBytes: Number.isFinite(megabytes) && megabytes > 0 ? megabytes * MiB : undefined }
    },
  },
  {
    // Apple silicon: the GPU shares system memory, so there is a name and no separate VRAM.
    // Reporting a number here would be wrong in the direction that matters -- it would be
    // counted twice against the same bytes the memory check already counted.
    platforms: ["darwin"],
    command: "sysctl",
    args: ["-n", "machdep.cpu.brand_string"],
    parse: (stdout) => {
      const brand = stdout.trim()
      if (!brand.startsWith("Apple ")) return undefined
      return { name: `${brand} (unified memory)`, vramBytes: undefined }
    },
  },
]

/**
 * Try each probe for this platform, first answer wins, every failure is silent.
 *
 * Silent is right: on a machine with no discrete GPU, `nvidia-smi` not existing is the
 * normal state of the world, not a condition to report. The caller gets `undefined` and
 * says "not measured", which is the true statement.
 *
 * Runs through `AppProcess.run`, the service the rest of the engine shells out with, rather
 * than driving the spawner directly -- output collection, truncation and timeout handling
 * already live there and a second copy of them would drift.
 */
export const probe = Effect.fn("LocalGpuProbe.probe")(function* (platform: string) {
  const process = yield* AppProcess.Service
  for (const candidate of PROBES) {
    if (!candidate.platforms.includes(platform)) continue
    const result = yield* Effect.gen(function* () {
      const run = yield* process
        .run(ChildProcess.make(candidate.command, [...candidate.args], { stdin: "ignore", extendEnv: true }))
        .pipe(Effect.flatMap(requireSuccess))
      return candidate.parse(run.stdout.toString("utf8"))
    }).pipe(
      Effect.timeout(PROBE_TIMEOUT),
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
    if (result !== undefined) return result
  }
  return undefined
})
