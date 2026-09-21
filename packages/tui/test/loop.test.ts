import { describe, expect, test } from "bun:test"
import { LOOP_MARKERS, cyclePrompt, isStalled, parseLedger, readMarkers } from "../src/feature-plugins/session/loop"

/*
  What is worth testing here is the part that makes this an autopilot rather than a re-sender: the markers
  are a contract between the prompt text and the parser, and the stall detector is the only thing that
  notices a loop going in circles. Both fail SILENTLY when wrong -- a loop that never stops looks like a
  loop that is working, right up until the cycle cap.
*/

describe("readMarkers", () => {
  test("reads a completion claim out of surrounding prose", () => {
    const reply = `I ran the suite and it is green.\n\n${LOOP_MARKERS.done} — verified by 317 passing tests.`
    expect(readMarkers(reply).done).toBe(true)
  })

  test("reads a block, which must stop the loop rather than be retried", () => {
    const reply = `I cannot reach the production database.\n${LOOP_MARKERS.blocked} I need MIGRATION_DATABASE_URL.`
    const markers = readMarkers(reply)
    expect(markers.blocked).toBe(true)
    expect(markers.done).toBe(false)
  })

  test("takes the LAST plan when a reply revises itself", () => {
    // A model that changes its mind mid-reply meant the revision, not the first thought.
    const reply = [
      `${LOOP_MARKERS.next} add the failing test`,
      "on reflection the test already exists",
      `${LOOP_MARKERS.next} fix the Windows branch in _safe_chmod`,
    ].join("\n")
    expect(readMarkers(reply).next).toBe("fix the Windows branch in _safe_chmod")
  })

  test("collects every rejected approach, since they all have to reach the next cycle", () => {
    const reply = [
      `${LOOP_MARKERS.rejected} patching the caller instead of the helper`,
      `${LOOP_MARKERS.rejected} widening the type to silence the checker`,
      `${LOOP_MARKERS.next} fix the helper`,
    ].join("\n")
    expect(readMarkers(reply).rejected).toEqual([
      "patching the caller instead of the helper",
      "widening the type to silence the checker",
    ])
  })

  test("a reply with no markers yields nothing rather than guessing", () => {
    const markers = readMarkers("I had a look around and things seem fine.")
    expect(markers.done).toBe(false)
    expect(markers.blocked).toBe(false)
    expect(markers.next).toBeUndefined()
    expect(markers.rejected).toEqual([])
  })
})

describe("isStalled", () => {
  test("three identical plans in a row is a loop with no exit", () => {
    expect(isStalled(["run the tests", "run the tests", "run the tests"])).toBe(true)
  })

  test("two is patience, not a stall", () => {
    // A model legitimately repeats a step while waiting on something external, like a build.
    expect(isStalled(["run the tests", "run the tests"])).toBe(false)
  })

  test("ignores punctuation, case and spacing, which are not a change of plan", () => {
    expect(isStalled(["Run the tests", "run  the tests.", "RUN THE TESTS"])).toBe(true)
  })

  test("progress resets it", () => {
    expect(isStalled(["run the tests", "run the tests", "fix the failing assertion"])).toBe(false)
  })

  test("blank plans are not treated as repetition", () => {
    // Otherwise a model that simply stopped emitting the marker would read as stuck on an empty step.
    expect(isStalled(["", "", ""])).toBe(false)
  })
})

describe("cyclePrompt", () => {
  test("carries the goal and the cycle position", () => {
    const prompt = cyclePrompt({ goal: "make CI green", rejected: [], recentNext: [] }, 3, 25)
    expect(prompt).toContain("make CI green")
    expect(prompt).toContain("cycle 3 of at most 25")
  })

  test("carries rejected approaches, which is the whole reason cycles differ", () => {
    /*
      Without this the loop is a re-sender: cycle N+1 gets the same input as cycle N and walks into the
      same wall. This assertion is the one that would catch a regression back to that behaviour.
    */
    const prompt = cyclePrompt(
      { goal: "make CI green", rejected: ["bumping the timeout"], recentNext: [] },
      2,
      25,
    )
    expect(prompt).toContain("ALREADY TRIED AND REJECTED")
    expect(prompt).toContain("bumping the timeout")
  })

  test("omits the rejected section entirely when there is nothing to say", () => {
    const prompt = cyclePrompt({ goal: "make CI green", rejected: [], recentNext: [] }, 1, 25)
    expect(prompt).not.toContain("ALREADY TRIED AND REJECTED")
  })

  test("asks for the markers it will later parse", () => {
    // The prompt and the parser have to agree; this is what keeps them from drifting apart.
    const prompt = cyclePrompt({ goal: "g", rejected: [], recentNext: [] }, 1, 5)
    expect(prompt).toContain(LOOP_MARKERS.next)
    expect(prompt).toContain(LOOP_MARKERS.done)
    expect(prompt).toContain(LOOP_MARKERS.blocked)
    expect(prompt).toContain(LOOP_MARKERS.rejected)
  })
})

describe("parseLedger", () => {
  /*
    Anything read back from disk is untrusted: an older build wrote a different shape, a file was
    hand-edited, a write was truncated. The failure to avoid is feeding the model a half-read list of
    things it must not retry -- it would then retry them, or avoid things it never tried.
  */
  test("accepts a well-formed ledger", () => {
    expect(
      parseLedger({ goal: "make CI green", rejected: ["bump the timeout"], recentNext: ["run tests"] }),
    ).toEqual({ goal: "make CI green", rejected: ["bump the timeout"], recentNext: ["run tests"] })
  })

  test("refuses anything without a real goal, since the goal IS the loop", () => {
    expect(parseLedger(undefined)).toBeUndefined()
    expect(parseLedger(null)).toBeUndefined()
    expect(parseLedger("make CI green")).toBeUndefined()
    expect(parseLedger({ rejected: ["x"] })).toBeUndefined()
    expect(parseLedger({ goal: "" })).toBeUndefined()
    expect(parseLedger({ goal: "   " })).toBeUndefined()
  })

  test("drops non-string entries instead of rejecting the whole ledger", () => {
    // One bad entry should cost that entry, not the goal and every other dead end alongside it.
    expect(parseLedger({ goal: "g", rejected: ["keep", 42, null, "also keep"] })).toEqual({
      goal: "g",
      rejected: ["keep", "also keep"],
      recentNext: [],
    })
  })

  test("tolerates missing lists rather than requiring them", () => {
    expect(parseLedger({ goal: "g" })).toEqual({ goal: "g", rejected: [], recentNext: [] })
  })

  test("a list that is not a list becomes empty, not a crash", () => {
    expect(parseLedger({ goal: "g", rejected: "bump the timeout" })).toEqual({
      goal: "g",
      rejected: [],
      recentNext: [],
    })
  })
})
