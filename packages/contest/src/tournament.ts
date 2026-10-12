/**
 * Pairwise judging, combined.
 *
 * Pointwise scores tie in most pairs and correlate weakly with which candidate is actually better
 * (arXiv 2603.12520), so candidates are compared two at a time. Each pair is shown to each reviewer in
 * BOTH orders. A vote counts only when the reviewer prefers the same candidate both times; a reviewer
 * that flips with the order is reporting position, not quality, and that pair is a tie for them.
 */

export type Vote = {
  first: string
  second: string
  reviewer: string
  winner: string | "tie"
  confidence: number
  reasons: string[]
}

export type PairOutcome = {
  a: string
  b: string
  /** Consistent preferences per reviewer: the slot it chose, or "tie". */
  verdicts: { reviewer: string; winner: string | "tie" }[]
  winner: string | "tie"
}

export type Standing = { slot: string; wins: number; losses: number; ties: number; points: number }

export function pairs(slots: string[]): [string, string][] {
  const result: [string, string][] = []
  for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) result.push([slots[i]!, slots[j]!])
  return result
}

/** Reduces both orders of one pair from one reviewer to a single consistent verdict. */
export function consistent(votes: Vote[], a: string, b: string, reviewer: string): string | "tie" {
  const mine = votes.filter(
    (vote) =>
      vote.reviewer === reviewer &&
      ((vote.first === a && vote.second === b) || (vote.first === b && vote.second === a)),
  )
  if (mine.length < 2) return mine.length === 1 ? "tie" : "tie"
  const winners = new Set(mine.map((vote) => vote.winner))
  return winners.size === 1 ? [...winners][0]! : "tie"
}

export function combine(
  slots: string[],
  votes: Vote[],
  reviewers: string[],
): { outcomes: PairOutcome[]; standings: Standing[] } {
  const outcomes: PairOutcome[] = []
  for (const [a, b] of pairs(slots)) {
    const verdicts = reviewers
      .filter((reviewer) =>
        votes.some(
          (vote) =>
            vote.reviewer === reviewer &&
            [vote.first, vote.second].includes(a) &&
            [vote.first, vote.second].includes(b),
        ),
      )
      .map((reviewer) => ({ reviewer, winner: consistent(votes, a, b, reviewer) }))
    const forA = verdicts.filter((verdict) => verdict.winner === a).length
    const forB = verdicts.filter((verdict) => verdict.winner === b).length
    outcomes.push({ a, b, verdicts, winner: forA > forB ? a : forB > forA ? b : "tie" })
  }
  const standings = slots.map((slot) => {
    const mine = outcomes.filter((outcome) => outcome.a === slot || outcome.b === slot)
    const wins = mine.filter((outcome) => outcome.winner === slot).length
    const ties = mine.filter((outcome) => outcome.winner === "tie").length
    const losses = mine.length - wins - ties
    return { slot, wins, losses, ties, points: wins + ties / 2 }
  })
  return { outcomes, standings }
}

/** Order by tournament points, then by the Quality Score, then by slot so the order is stable. */
export function rank(standings: Standing[], quality: Record<string, number>) {
  return [...standings].sort(
    (x, y) => y.points - x.points || (quality[y.slot] ?? 0) - (quality[x.slot] ?? 0) || x.slot.localeCompare(y.slot),
  )
}

/**
 * How clearly the winner won: the share of its pairs it took outright. 1 is a clean sweep. With a single
 * candidate there is nothing to judge, and the consensus is trivially complete.
 */
export function consensus(winner: Standing | undefined, total: number) {
  if (!winner) return 0
  if (total <= 1) return 1
  return winner.wins / (total - 1)
}
