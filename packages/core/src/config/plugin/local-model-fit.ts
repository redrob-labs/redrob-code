export * as LocalModelFit from "./local-model-fit"

/**
 * Whether this machine can run a local model, and if not, exactly what is short.
 *
 * PA-8's decisive half. Running a model locally is not a preference, it is a hardware
 * question, and the only dishonest answer is a confident one. So this module is built around
 * three rules:
 *
 *   1. It reports MEASURED facts, never estimates dressed as facts. Total and available
 *      memory and the CPU come from the OS. A GPU is read where the platform exposes it and
 *      reported as UNKNOWN where it does not -- `unknown` is a third answer, distinct from
 *      "no GPU", because a machine with a GPU we cannot see must not be told it has none.
 *   2. It never invents a model's size. The required figure comes from whoever is offering
 *      the model -- the runtime's own registry -- and is passed in. A fit check against a
 *      size this module guessed would be a guess wearing a verdict's clothes.
 *   3. A refusal names the constraint and the shortfall. "Your machine cannot run this" is
 *      not actionable; "needs 8.0 GiB of available memory, this machine has 3.2 GiB free of
 *      15.5 GiB total" tells the user whether closing something would fix it.
 *
 * There is deliberately NO cloud fallback here, silently or otherwise. A user who asked for
 * a local model asked for the data to stay on the machine; quietly answering from a hosted
 * model would defeat the only reason to want this, and would do it invisibly.
 */

import * as os from "node:os"

/** What the machine is, as measured. Every field is read, none is inferred. */
export type Hardware = {
  readonly platform: string
  readonly arch: string
  readonly cores: number
  readonly totalBytes: number
  readonly availableBytes: number
  /**
   * The GPU, when this platform lets us see it.
   *
   * `undefined` means NOT MEASURED, not absent. The difference matters: a refusal that
   * claims a machine has no GPU when we simply could not look is a false statement about
   * the user's own computer.
   */
  readonly gpu?: { readonly name: string; readonly vramBytes?: number | undefined } | undefined
}

/** The verdict. A refusal always carries the numbers that produced it. */
export type Fit =
  | { readonly kind: "fits"; readonly hardware: Hardware }
  | {
      readonly kind: "short"
      readonly hardware: Hardware
      /** Which constraint failed, for a caller that wants to branch rather than print. */
      readonly constraint: "memory" | "arch"
      readonly requiredBytes: number
      readonly shortfallBytes: number
      readonly reason: string
    }

/**
 * Headroom beyond the weights themselves.
 *
 * A model's file size is not its running size: the runtime holds the KV cache, the context
 * window and its own working set alongside the weights. 20% with a 1 GiB floor is a
 * deliberately rough allowance, and it is named here rather than buried so that a caller
 * reading a refusal can see it is part of the requirement.
 *
 * Rough is correct for this. The alternative is a precise-looking formula over quantisation,
 * context length and runtime, which would be wrong in a way that reads as authoritative.
 */
export const HEADROOM_FRACTION = 0.2
export const HEADROOM_FLOOR_BYTES = 1024 ** 3

export const requirementFor = (modelBytes: number): number =>
  modelBytes + Math.max(Math.round(modelBytes * HEADROOM_FRACTION), HEADROOM_FLOOR_BYTES)

const GiB = 1024 ** 3
const gib = (bytes: number): string => `${(bytes / GiB).toFixed(1)} GiB`

/**
 * Architectures a local runtime has builds for.
 *
 * Checked because the failure is otherwise a confusing download: the weights arrive, the
 * runtime will not start, and nothing in that sequence mentions the CPU.
 */
const SUPPORTED_ARCH = new Set(["x64", "arm64"])

/**
 * Measure the machine.
 *
 * `availableBytes` uses `os.freemem()`, which on Linux counts reclaimable page cache as used
 * and therefore UNDERSTATES what a process could actually get. That direction is the safe
 * one: it can refuse a model that would in fact have squeezed in, and it will not promise
 * one that would have been killed mid-generation. The opposite error loses the user's work.
 */
export const measure = (gpu?: Hardware["gpu"]): Hardware => ({
  platform: os.platform(),
  arch: os.arch(),
  cores: os.cpus().length,
  totalBytes: os.totalmem(),
  availableBytes: os.freemem(),
  gpu,
})

/**
 * Can this machine run a model of this size?
 *
 * Memory is checked against AVAILABLE rather than total, because a model that needs more
 * than is free today does not run today, however large the machine is. The refusal reports
 * both numbers so the user can tell "buy a bigger machine" from "close your other windows".
 */
export const fit = (input: { readonly modelBytes: number; readonly hardware: Hardware }): Fit => {
  const { hardware } = input
  if (!SUPPORTED_ARCH.has(hardware.arch)) {
    return {
      kind: "short",
      hardware,
      constraint: "arch",
      requiredBytes: 0,
      shortfallBytes: 0,
      reason: `local models need an x64 or arm64 CPU; this machine reports ${hardware.arch}`,
    }
  }

  const requiredBytes = requirementFor(input.modelBytes)
  if (hardware.availableBytes >= requiredBytes) return { kind: "fits", hardware }

  const shortfallBytes = requiredBytes - hardware.availableBytes
  const fitsIfFreed = hardware.totalBytes >= requiredBytes
  return {
    kind: "short",
    hardware,
    constraint: "memory",
    requiredBytes,
    shortfallBytes,
    reason: [
      `this model needs about ${gib(requiredBytes)} of memory`,
      `(${gib(input.modelBytes)} of weights plus runtime headroom)`,
      `and ${gib(hardware.availableBytes)} is free of ${gib(hardware.totalBytes)} total`,
      fitsIfFreed
        ? `-- short by ${gib(shortfallBytes)}, which this machine has if you close something`
        : `-- short by ${gib(shortfallBytes)}, more than this machine has in total`,
    ].join(" "),
  }
}
