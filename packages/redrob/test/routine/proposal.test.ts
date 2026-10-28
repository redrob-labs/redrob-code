import { describe, expect, test } from "bun:test"
import { RoutineProposal } from "../../src/routine/proposal"
import type { Repetition } from "../../src/routine/similarity"

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

const repetition = (key: string, days: readonly number[]): Repetition => ({
  key,
  occurrences: days.map((day) => ({ id: `${key}-${day}`, prompt: key, at: day * DAY })),
  exemplar: key,
})

const email = repetition("summarise-email-unread", [1, 2, 3])

describe("RoutineProposal.decide — the cadence", () => {
  test("a repetition with no history is offered", () => {
    const decision = RoutineProposal.decide({ repetitions: [email], now: 4 * DAY })
    expect(decision.offer?.key).toBe(email.key)
    expect(decision.skipped).toEqual([])
  })

  test("an ACCEPTED repetition is never offered again, with no expiry", () => {
    const state = RoutineProposal.recordAnswer(RoutineProposal.emptyState, {
      key: email.key,
      answer: "accepted",
      at: 4 * DAY,
    })
    const soon = RoutineProposal.decide({ repetitions: [email], state, now: 5 * DAY })
    const muchLater = RoutineProposal.decide({ repetitions: [email], state, now: 4_000 * DAY })

    expect(soon.offer).toBeUndefined()
    expect(soon.skipped).toEqual([{ key: email.key, reason: "accepted" }])
    expect(muchLater.offer).toBeUndefined()
    expect(muchLater.skipped[0]!.reason).toBe("accepted")
  })

  test("a DECLINED repetition does not come back immediately", () => {
    const state = RoutineProposal.recordAnswer(RoutineProposal.emptyState, {
      key: email.key,
      answer: "declined",
      at: 4 * DAY,
    })
    const nextDay = RoutineProposal.decide({ repetitions: [email], state, now: 5 * DAY })

    expect(nextDay.offer).toBeUndefined()
    expect(nextDay.skipped[0]!.reason).toBe("declined-recently")
    expect(nextDay.skipped[0]!.eligibleAt).toBe(11 * DAY)
  })

  test("after the backoff a decline is reconsidered, but only once the work recurred", () => {
    const state = RoutineProposal.recordAnswer(RoutineProposal.emptyState, {
      key: email.key,
      answer: "declined",
      at: 4 * DAY,
    })

    // Backoff elapsed, but every occurrence predates the decline: time alone is not new evidence.
    const stale = RoutineProposal.decide({ repetitions: [email], state, now: 12 * DAY })
    expect(stale.offer).toBeUndefined()
    expect(stale.skipped[0]!.reason).toBe("no-new-occurrences")

    // The user did it again after declining.
    const recurred = repetition(email.key, [1, 2, 3, 11])
    const fresh = RoutineProposal.decide({ repetitions: [recurred], state, now: 12 * DAY })
    expect(fresh.offer?.key).toBe(email.key)
  })

  test("the backoff grows, and the third decline stops it for good", () => {
    const recurring = (days: number[]) => repetition(email.key, days)
    let state = RoutineProposal.emptyState

    state = RoutineProposal.recordAnswer(state, { key: email.key, answer: "declined", at: 4 * DAY })
    expect(RoutineProposal.decide({ repetitions: [recurring([5])], state, now: 10 * DAY }).skipped[0]!.eligibleAt).toBe(
      11 * DAY,
    )

    state = RoutineProposal.recordAnswer(state, { key: email.key, answer: "declined", at: 12 * DAY })
    // Second decline: a month, not a week.
    expect(RoutineProposal.decide({ repetitions: [recurring([13])], state, now: 20 * DAY }).skipped[0]!.eligibleAt).toBe(
      42 * DAY,
    )

    state = RoutineProposal.recordAnswer(state, { key: email.key, answer: "declined", at: 45 * DAY })
    const third = RoutineProposal.decide({ repetitions: [recurring([46])], state, now: 10_000 * DAY })
    expect(third.offer).toBeUndefined()
    expect(third.skipped[0]!.reason).toBe("declined-permanently")
  })

  test("an unanswered proposal blocks a re-offer for the grace period, then may be offered again", () => {
    const state = RoutineProposal.recordOffer(RoutineProposal.emptyState, {
      key: email.key,
      at: 4 * DAY,
      occurrences: 3,
    })

    const during = RoutineProposal.decide({ repetitions: [email], state, now: 6 * DAY })
    expect(during.offer).toBeUndefined()
    expect(during.skipped[0]!.reason).toBe("outstanding")
    expect(during.skipped[0]!.eligibleAt).toBe(11 * DAY)

    const after = RoutineProposal.decide({ repetitions: [email], state, now: 12 * DAY })
    expect(after.offer?.key).toBe(email.key)
  })

  test("only one proposal is made per quiet period, however many repetitions qualify", () => {
    const other = repetition("rebase-branch-release", [1, 2, 3])
    const first = RoutineProposal.decide({ repetitions: [email, other], now: 4 * DAY })
    expect(first.offer).toBeDefined()
    // Equally strong, so the key breaks the tie; the other one is held back, not dropped.
    expect(first.offer!.key).toBe(other.key)
    expect(first.skipped).toEqual([{ key: email.key, reason: "not-the-strongest" }])

    const state = RoutineProposal.recordOffer(RoutineProposal.emptyState, {
      key: first.offer!.key,
      at: 4 * DAY,
      occurrences: 3,
    })
    const immediately = RoutineProposal.decide({
      repetitions: [email],
      state,
      now: 4 * DAY + HOUR,
    })

    expect(immediately.offer).toBeUndefined()
    expect(immediately.skipped[0]!.reason).toBe("quiet-period")
    expect(immediately.skipped[0]!.eligibleAt).toBe(5 * DAY)
  })

  test("the strongest repetition wins, by occurrence count then recency", () => {
    const weak = repetition("a-weak", [1, 2, 3])
    const strong = repetition("b-strong", [1, 2, 3, 4])
    const decision = RoutineProposal.decide({ repetitions: [weak, strong], now: 5 * DAY })

    expect(decision.offer?.key).toBe("b-strong")
    expect(decision.skipped).toEqual([{ key: "a-weak", reason: "not-the-strongest" }])
  })

  test("no repetitions means no offer and nothing skipped", () => {
    expect(RoutineProposal.decide({ repetitions: [], now: 4 * DAY })).toEqual({ skipped: [] })
  })

  test("the quiet period is not consulted when nothing is eligible anyway", () => {
    const state = RoutineProposal.recordAnswer(RoutineProposal.emptyState, {
      key: email.key,
      answer: "accepted",
      at: 1 * DAY,
    })
    const decision = RoutineProposal.decide({ repetitions: [email], state, now: 2 * DAY })
    expect(decision.skipped).toEqual([{ key: email.key, reason: "accepted" }])
  })

  test("recordAnswer does not reset the anti-nag clock", () => {
    const offered = RoutineProposal.recordOffer(RoutineProposal.emptyState, {
      key: email.key,
      at: 4 * DAY,
      occurrences: 3,
    })
    const answered = RoutineProposal.recordAnswer(offered, { key: email.key, answer: "declined", at: 4 * DAY + HOUR })
    expect(answered.lastProposalAt).toBe(4 * DAY)
  })
})
