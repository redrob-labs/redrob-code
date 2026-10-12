import type { DiffStats } from "./diffstats"

/**
 * The Quality Score: a number from 0 to 100 built only from automatic measurements, no model involved.
 *
 * Every component is a penalty for something a reviewer would push back on, scaled by the size of the
 * change so a large change is not punished for being large. These are DEFAULT weights. Calibrating them
 * against each repository's own defect history is milestone 4; until then the defaults are stated
 * rather than hidden, so a reader can see why a candidate scored what it did.
 */

export type CheckDelta = {
  /** Checks that passed on the base commit and fail with this candidate. */
  regressions: number
  /** Checks that failed on the base commit and pass with this candidate. */
  fixes: number
  /** Warning lines added to check output relative to the base commit. */
  newWarnings: number
}

export const WEIGHTS = {
  debrisPer100: 6,
  duplicatePer100: 4,
  nestingOver4: 4,
  longLinesPer100: 1,
  oversize: 10,
  untested: 8,
  regression: 35,
  warning: 2,
} as const

export type Component = { name: string; penalty: number; detail: string }
export type Quality = { score: number; components: Component[] }

const per100 = (value: number, base: number) => (value * 100) / Math.max(base, 20)

export function score(stats: DiffStats, options: { referenceSize?: number; checks?: CheckDelta } = {}): Quality {
  const components: Component[] = []
  const add = (name: string, penalty: number, detail: string) => {
    if (penalty > 0) components.push({ name, penalty: Math.round(penalty * 10) / 10, detail })
  }
  const code = stats.codeAdded

  add(
    "debris",
    Math.min(20, (WEIGHTS.debrisPer100 * per100(stats.debris, code)) / 10),
    `${stats.debris} TODO/debug/lint-suppression line(s)`,
  )
  add(
    "duplication",
    Math.min(20, (WEIGHTS.duplicatePer100 * per100(stats.duplicateWindows, code)) / 5),
    `${stats.duplicateWindows} repeated 4-line block(s)`,
  )
  add(
    "nesting",
    Math.min(16, WEIGHTS.nestingOver4 * Math.max(0, stats.maxNesting - 4)),
    `deepest new code is ${stats.maxNesting} levels in`,
  )
  add(
    "long lines",
    Math.min(6, (WEIGHTS.longLinesPer100 * per100(stats.longLines, code)) / 5),
    `${stats.longLines} line(s) over 120 characters`,
  )

  if (options.referenceSize && options.referenceSize > 0 && code > 0) {
    const ratio = code / options.referenceSize
    if (ratio > 2)
      add(
        "size",
        Math.min(15, WEIGHTS.oversize * Math.log2(ratio / 2 + 1)),
        `${code} code lines, ${ratio.toFixed(1)}x the reference`,
      )
  }
  if (code >= 10 && stats.testAdded === 0)
    add("tests", WEIGHTS.untested, "changed code without adding or changing a test")

  if (options.checks) {
    add(
      "regressions",
      WEIGHTS.regression * options.checks.regressions,
      `${options.checks.regressions} check(s) that passed before now fail`,
    )
    add(
      "warnings",
      Math.min(20, WEIGHTS.warning * options.checks.newWarnings),
      `${options.checks.newWarnings} new warning(s)`,
    )
  }

  const total = components.reduce((sum, component) => sum + component.penalty, 0)
  return { score: Math.max(0, Math.round((100 - total) * 10) / 10), components }
}

/** Where `value` falls among `distribution`, as the share of entries it equals or beats (0-100). */
export function percentile(value: number, distribution: number[]): number | null {
  if (distribution.length === 0) return null
  const atOrBelow = distribution.filter((entry) => entry <= value).length
  return Math.round((atOrBelow * 1000) / distribution.length) / 10
}

export function median(values: number[]) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
