import type { Repetition } from "./similarity"

/**
 * W-5, second half: the cadence that stops a proposal from nagging.
 *
 * Also PURE. Every rule below is a function of (repetitions, remembered answers, now), so the
 * behaviour that actually matters — "a declined proposal must not come back immediately, an
 * accepted one must never be offered again" — is testable without a session, a clock or a store.
 *
 * The rules, in the order they are applied:
 *
 *  - ACCEPTED is forever. A repetition that became a routine is never proposed again, with no
 *    expiry and no backoff. There is nothing left to offer.
 *  - DECLINED backs off, and the backoff grows: a week, then a month, then never. The third
 *    decline is read as "stop asking about this", because a person who has said no three times is
 *    not going to say yes the fourth.
 *  - A decline is also only reconsidered once the user has done the thing AGAIN since declining.
 *    Time passing is not new evidence; repeating the work is.
 *  - OUTSTANDING proposals expire rather than blocking forever. A proposal shown and never
 *    answered is not re-offered for `outstandingGraceMs`; after that it may be offered once more.
 *  - At most ONE proposal is made per `quietPeriodMs`, across all repetitions. This is the rule
 *    that stops a burst of similar work from producing a burst of proposals.
 */

export type Answer = "accepted" | "declined"

export interface Record_ {
  readonly key: string
  /** When this repetition was last proposed, epoch millis. Absent when never proposed. */
  readonly lastOfferedAt?: number
  /** How many occurrences the repetition had when it was last proposed. */
  readonly offeredAtOccurrences?: number
  readonly answer?: Answer
  readonly answeredAt?: number
  /** How many times the user has declined this repetition. */
  readonly declines?: number
}

/** Everything the decision remembers, keyed by repetition key. */
export interface State {
  readonly records: Readonly<Record<string, Record_>>
  /** When ANY proposal was last made, epoch millis. The anti-nag clock. */
  readonly lastProposalAt?: number
}

export const emptyState: State = { records: {} }

export interface Limits {
  /** Minimum gap between any two proposals, whatever they are about. Default 24 hours. */
  readonly quietPeriodMs?: number
  /** Backoff after the 1st, 2nd and subsequent declines. A missing entry means "never again". */
  readonly declineBackoffMs?: readonly number[]
  /** New occurrences required after a decline before the repetition may be proposed again. */
  readonly occurrencesAfterDecline?: number
  /** How long an unanswered proposal blocks a re-offer. Default 7 days. */
  readonly outstandingGraceMs?: number
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

export const defaultLimits = {
  quietPeriodMs: 24 * HOUR,
  declineBackoffMs: [7 * DAY, 30 * DAY],
  occurrencesAfterDecline: 1,
  outstandingGraceMs: 7 * DAY,
} as const satisfies Required<Limits>

export type SkipReason =
  | "accepted"
  | "declined-permanently"
  | "declined-recently"
  | "no-new-occurrences"
  | "outstanding"
  | "quiet-period"
  | "not-the-strongest"

export interface Skipped {
  readonly key: string
  readonly reason: SkipReason
  /** When the reason is time-based, the earliest moment this could be offered. */
  readonly eligibleAt?: number
}

export interface Decision {
  /** The one repetition worth proposing now, if any. */
  readonly offer?: Repetition
  /** Every repetition that was not offered, and why. */
  readonly skipped: readonly Skipped[]
}

const backoffFor = (declines: number, limits: Required<Limits>): number | undefined =>
  limits.declineBackoffMs[declines - 1]

/**
 * PURE. Decides whether to propose a routine right now, and which one.
 *
 * At most one offer comes back, because the surface that shows a proposal interrupts someone. The
 * strongest repetition wins, measured by occurrence count and then by recency; the rest come back
 * in `skipped` with the reason, which is what makes the cadence inspectable instead of a black box.
 */
export const decide = (input: {
  readonly repetitions: readonly Repetition[]
  readonly state?: State
  readonly now: number
  readonly limits?: Limits
}): Decision => {
  const limits: Required<Limits> = { ...defaultLimits, ...input.limits }
  const state = input.state ?? emptyState
  const skipped: Skipped[] = []
  const eligible: Repetition[] = []

  for (const repetition of input.repetitions) {
    const record = state.records[repetition.key]

    if (record?.answer === "accepted") {
      skipped.push({ key: repetition.key, reason: "accepted" })
      continue
    }

    if (record?.answer === "declined") {
      const declines = record.declines ?? 1
      const backoff = backoffFor(declines, limits)
      if (backoff === undefined) {
        skipped.push({ key: repetition.key, reason: "declined-permanently" })
        continue
      }
      const eligibleAt = (record.answeredAt ?? 0) + backoff
      if (input.now < eligibleAt) {
        skipped.push({ key: repetition.key, reason: "declined-recently", eligibleAt })
        continue
      }
      const since = repetition.occurrences.filter(
        (occurrence) => occurrence.at > (record.answeredAt ?? 0),
      ).length
      if (since < limits.occurrencesAfterDecline) {
        skipped.push({ key: repetition.key, reason: "no-new-occurrences" })
        continue
      }
      eligible.push(repetition)
      continue
    }

    if (record?.lastOfferedAt !== undefined) {
      const eligibleAt = record.lastOfferedAt + limits.outstandingGraceMs
      if (input.now < eligibleAt) {
        skipped.push({ key: repetition.key, reason: "outstanding", eligibleAt })
        continue
      }
    }

    eligible.push(repetition)
  }

  if (eligible.length === 0) return { skipped }

  if (state.lastProposalAt !== undefined) {
    const eligibleAt = state.lastProposalAt + limits.quietPeriodMs
    if (input.now < eligibleAt) {
      return {
        skipped: [
          ...skipped,
          ...eligible.map((repetition) => ({
            key: repetition.key,
            reason: "quiet-period" as const,
            eligibleAt,
          })),
        ],
      }
    }
  }

  const ranked = eligible.slice().sort((a, b) => {
    if (b.occurrences.length !== a.occurrences.length) return b.occurrences.length - a.occurrences.length
    const bLast = b.occurrences[b.occurrences.length - 1]?.at ?? 0
    const aLast = a.occurrences[a.occurrences.length - 1]?.at ?? 0
    if (bLast !== aLast) return bLast - aLast
    return a.key.localeCompare(b.key)
  })

  const [offer, ...rest] = ranked
  return {
    offer,
    skipped: [...skipped, ...rest.map((repetition) => ({ key: repetition.key, reason: "not-the-strongest" as const }))],
  }
}

/** PURE. The state after a proposal has been shown. */
export const recordOffer = (state: State, input: { key: string; at: number; occurrences: number }): State => ({
  records: {
    ...state.records,
    [input.key]: {
      ...state.records[input.key],
      key: input.key,
      lastOfferedAt: input.at,
      offeredAtOccurrences: input.occurrences,
    },
  },
  lastProposalAt: input.at,
})

/**
 * PURE. The state after the user answered.
 *
 * An accept is terminal. A decline increments the decline count, which is what makes the backoff
 * grow and, on the third decline, stop entirely.
 */
export const recordAnswer = (state: State, input: { key: string; answer: Answer; at: number }): State => {
  const existing = state.records[input.key]
  return {
    ...state,
    records: {
      ...state.records,
      [input.key]: {
        ...existing,
        key: input.key,
        answer: input.answer,
        answeredAt: input.at,
        declines: input.answer === "declined" ? (existing?.declines ?? 0) + 1 : existing?.declines,
      },
    },
  }
}

export * as RoutineProposal from "./proposal"
