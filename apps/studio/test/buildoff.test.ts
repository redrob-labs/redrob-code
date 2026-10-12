import { expect, test } from "bun:test"
import type { BuildoffResult } from "@redrob-code/desktop/bridge"
import { initialRun, matrix, progress, reduce } from "../src/lib/buildoff"

test("folds messages into lanes, stages and the result, ignoring other runs", () => {
  let state = initialRun("r1")
  state = reduce(state, { runId: "r1", kind: "event", event: { type: "stage", stage: "building" } })
  state = reduce(state, { runId: "r1", kind: "event", event: { type: "candidate", slot: "B", status: "preparing" } })
  state = reduce(state, {
    runId: "r1",
    kind: "event",
    event: { type: "candidate", slot: "A", status: "building", costUsd: 0.2, tools: 3 },
  })
  state = reduce(state, { runId: "r1", kind: "event", event: { type: "candidate", slot: "A", status: "done" } })
  state = reduce(state, { runId: "other", kind: "error", message: "not mine" })
  state = reduce(state, { runId: "r1", kind: "event", event: { type: "note", message: "escalated" } })
  expect(state.stage).toBe("building")
  expect(state.lanes).toEqual([
    { slot: "A", status: "done", costUsd: 0.2, tools: 3 },
    { slot: "B", status: "preparing", costUsd: 0, tools: 0 },
  ])
  expect(state.notes).toEqual(["escalated"])
  expect(state.error).toBeNull()
  expect(progress("building")).toBe(33)
  expect(progress("ready")).toBe(100)
})

test("the matrix reads each pair from both sides", () => {
  const result = {
    candidates: [{ slot: "A" }, { slot: "B" }, { slot: "C" }],
    outcomes: [
      { a: "A", b: "B", winner: "A", verdicts: [] },
      { a: "A", b: "C", winner: "tie", verdicts: [] },
    ],
  } as unknown as BuildoffResult
  const { slots, cell } = matrix(result)
  expect(slots).toEqual(["A", "B", "C"])
  expect(cell("A", "B")).toBe("win")
  expect(cell("B", "A")).toBe("loss")
  expect(cell("C", "A")).toBe("tie")
  expect(cell("B", "C")).toBeNull()
  expect(cell("A", "A")).toBeNull()
})
