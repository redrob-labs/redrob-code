import { describe, expect, test } from "bun:test"
import { RoutineSimilarity } from "../../src/routine/similarity"

const same = (a: string, b: string) => RoutineSimilarity.isSubstantiallySame(a, b)
const score = (a: string, b: string) => Number(RoutineSimilarity.overlap(a, b).toFixed(3))

describe("RoutineSimilarity — repetitions it must recognise", () => {
  test("the same request worded twice", () => {
    expect(same("summarise my unread email", "summarise unread emails")).toBe(true)
    expect(score("summarise my unread email", "summarise unread emails")).toBe(1)
  })

  test("the same request once in full and once in shorthand", () => {
    const long = "run the weekly deployment report for the console"
    const short = "run the weekly deployment report"
    expect(same(long, short)).toBe(true)
  })

  test("a differing weekday is the repetition, not a difference", () => {
    expect(same("post the standup summary on Monday", "post the standup summary on Tuesday")).toBe(true)
  })

  test("a differing date or count is dropped before comparing", () => {
    expect(same("close the 3 oldest stale branches", "close the 12 oldest stale branches")).toBe(true)
    expect(same("file the expense report for 2026-09-30", "file the expense report for 2026-10-31")).toBe(true)
  })

  test("politeness and filler do not change the request", () => {
    expect(same("please summarise my unread email", "could you summarise the unread email")).toBe(true)
  })
})

describe("RoutineSimilarity — NEAR MISSES that must not match", () => {
  test("same object, different verb", () => {
    expect(same("summarise my unread email", "delete my unread email")).toBe(false)
    // Zero, not a low score: the heads differ, so no threshold can reach it.
    expect(score("summarise my unread email", "delete my unread email")).toBe(0)
  })

  test("same verb, different object", () => {
    expect(same("summarise my unread email", "summarise the quarterly report")).toBe(false)
    expect(score("summarise my unread email", "summarise the quarterly report")).toBe(0.2)
  })

  test("negated against affirmative", () => {
    expect(same("deploy the staging site", "do not deploy the staging site")).toBe(false)
    expect(score("deploy the staging site", "do not deploy the staging site")).toBe(0)
  })

  test("staging against production — one word, and it is the whole substance", () => {
    expect(same("deploy the staging site", "deploy the production site")).toBe(false)
    expect(score("deploy the staging site", "deploy the production site")).toBe(0.5)
  })

  test("the same action against a different named target", () => {
    expect(same("open the pull requests for redrob-code", "open the pull requests for redrob-browser")).toBe(false)
    expect(score("open the pull requests for redrob-code", "open the pull requests for redrob-browser")).toBe(0.6)
  })

  test("two prompts made only of stopwords — the empty-set trap", () => {
    expect(same("do it again", "do that now")).toBe(false)
    expect(score("do it again", "do that now")).toBe(0)
    // And one against itself, which is the version that would make a matcher match everything.
    expect(same("do it again", "do it again")).toBe(false)
  })

  test("an empty prompt matches nothing, including another empty prompt", () => {
    expect(same("", "")).toBe(false)
    expect(same("", "summarise my unread email")).toBe(false)
  })

  test("a single content word is too thin to be a routine, however exactly it repeats", () => {
    expect(same("deploy", "deploy")).toBe(false)
  })

  test("a shared action verb alone is not a repetition", () => {
    expect(same("run the tests", "run the installer")).toBe(false)
    expect(same("check the CI status", "check the mailbox")).toBe(false)
  })

  test("a longer prompt that merely contains the shorter one's words is not the same request", () => {
    const short = "review the diff"
    const long = "review the diff, then rewrite the migration, split the schema change out and open two pull requests"
    expect(same(short, long)).toBe(false)
  })

  test("a different destination is a different request even with the same action", () => {
    expect(same("book a flight to Seoul on 3 March", "book a flight to Tokyo on 11 June")).toBe(false)
  })
})

describe("RoutineSimilarity.groupRepetitions", () => {
  const at = (day: number) => day * 24 * 60 * 60 * 1000
  const occurrence = (id: string, prompt: string, day: number) => ({ id, prompt, at: at(day) })

  test("three sayings of the same thing are one repetition; a single one is none", () => {
    const groups = RoutineSimilarity.groupRepetitions([
      occurrence("a", "summarise my unread email", 1),
      occurrence("b", "summarise the unread emails", 2),
      occurrence("c", "please summarise unread email", 3),
      occurrence("d", "rebase the release branch", 3),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]!.occurrences.map((o) => o.id)).toEqual(["a", "b", "c"])
    expect(groups[0]!.exemplar).toBe("please summarise unread email")
  })

  test("the key is the intersection, so re-wording the next occurrence does not move it", () => {
    const first = RoutineSimilarity.groupRepetitions([
      occurrence("a", "summarise my unread email", 1),
      occurrence("b", "summarise the unread emails", 2),
      occurrence("c", "summarise unread email", 3),
    ])
    const later = RoutineSimilarity.groupRepetitions([
      occurrence("a", "summarise my unread email", 1),
      occurrence("b", "summarise the unread emails", 2),
      occurrence("c", "summarise unread email", 3),
      occurrence("d", "summarise unread email please", 4),
    ])

    expect(first[0]!.key).toBe("summarise-email-unread")
    expect(later[0]!.key).toBe(first[0]!.key)
  })

  test("occurrences older than the window do not count toward a repetition", () => {
    const groups = RoutineSimilarity.groupRepetitions(
      [
        occurrence("old", "summarise my unread email", 1),
        occurrence("a", "summarise the unread emails", 40),
        occurrence("b", "summarise unread email", 41),
      ],
      { now: at(42), windowMs: at(14) },
    )

    expect(groups).toHaveLength(0)
  })

  test("near-miss prompts stay in separate groups rather than chaining into one", () => {
    const groups = RoutineSimilarity.groupRepetitions([
      occurrence("a", "deploy the staging site", 1),
      occurrence("b", "deploy the production site", 2),
      occurrence("c", "deploy the preview site", 3),
    ])

    expect(groups).toHaveLength(0)
  })
})
