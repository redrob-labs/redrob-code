import { describe, expect, test } from "bun:test"
import { addDebris, duplicateBlock, injectBug, perturbations, skipTest } from "../src/perturb"
import { regressions, summarise, taskFromMessage, type TaskReport } from "../src/replay"

const patch = [
  "diff --git a/src/math.ts b/src/math.ts",
  "--- a/src/math.ts",
  "+++ b/src/math.ts",
  "@@ -1 +1,3 @@",
  " export const add = (a: number, b: number) => a + b",
  "+export const subtract = (a: number, b: number) => a - b",
  "+export const clamp = (x: number) => (x < 0 ? 0 : x)",
  "diff --git a/test/subtract.test.ts b/test/subtract.test.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/test/subtract.test.ts",
  "@@ -0,0 +1,2 @@",
  '+import { subtract } from "../src/math"',
  '+test("subtract", () => expect(subtract(3, 1)).toBe(2))',
].join("\n")

describe("perturbations", () => {
  test("a bug flips one operator in code, never in a test", () => {
    const bugged = injectBug(patch)!
    expect(bugged).toContain("+export const subtract = (a: number, b: number) => a + b")
    expect(bugged).toContain("expect(subtract(3, 1)).toBe(2)")
  })

  test("duplication, debris and a skipped test each make one kind of damage, and hunk counts stay right", () => {
    expect(duplicateBlock(patch)).toContain("@@ -1,1 +1,5 @@")
    expect(addDebris(patch)).toContain('console.log("debug") // TODO: remove')
    expect(skipTest(patch)).toContain('test.skip("subtract"')
    expect(perturbations(patch).map((entry) => entry.kind)).toEqual(["bug", "duplicate", "debris", "test-skip"])
  })

  test("a patch with nothing to damage yields nothing rather than a fake perturbation", () => {
    expect(perturbations("diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-old\n")).toEqual([])
  })
})

describe("replay bookkeeping", () => {
  test("the task is the commit message without its trailers", () => {
    const task = taskFromMessage(
      "Add subtract\n\nAdd a subtract function with a test.\n\nSigned-off-by: A <a@b>\nRedrob-Contest: c1\n",
    )
    expect(task).toEqual({
      subject: "Add subtract",
      task: "Add subtract\n\nAdd a subtract function with a test.",
      weak: false,
    })
    expect(taskFromMessage("fix").weak).toBe(true)
  })

  test("metrics separate the judges' winner from the best and the average attempt", () => {
    const task = (resolved: boolean[], winner: number, verdict: "winner" | "human" | "tie"): TaskReport => ({
      sha: "x",
      subject: "s",
      weak: false,
      valid: true,
      winner: String.fromCharCode(65 + winner),
      candidates: resolved.map((value, index) => ({
        slot: String.fromCharCode(65 + index),
        model: `m/${index}`,
        resolved: value,
        quality: 90,
        percentile: 80 + index,
      })),
      winnerResolved: resolved[winner],
      human: { quality: 90, percentile: 50, verdict },
      judge: { pairs: 2, correct: 1 },
      perturbation: [{ kind: "bug", trials: 2, correct: 2 }],
      identity: { trials: 2, ties: 1 },
      costUsd: 0.5,
    })
    const metrics = summarise([
      task([true, false, false], 0, "tie"),
      task([false, true, false], 0, "human"),
      { sha: "y", subject: "z", weak: true, valid: false, costUsd: 0 },
    ])
    expect(metrics).toMatchObject({
      tasks: 2,
      resolvedRate: 50,
      oracleRate: 100,
      singleAttemptRate: 33.3,
      atLeastHumanRate: 100,
      judgeGroundedAccuracy: 50,
      judgePerturbationAccuracy: 100,
      judgeIdentityRate: 50,
      costUsd: 1,
    })
    expect(metrics.perModel["m/0"]).toEqual({ tasks: 2, resolved: 1 })
  })

  test("a guarded metric only counts as a regression beyond its tolerance", () => {
    const base = summarise([])
    expect(regressions({ ...base, resolvedRate: 72 }, { resolvedRate: 75 })).toEqual([])
    expect(regressions({ ...base, resolvedRate: 69 }, { resolvedRate: 75 })).toEqual([
      { metric: "resolvedRate", baseline: 75, current: 69 },
    ])
    expect(regressions({ ...base, resolvedRate: null }, { resolvedRate: 75 })[0]?.current).toBeNull()
  })
})
