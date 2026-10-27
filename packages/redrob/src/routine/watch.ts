import { Effect } from "effect"
import { Process } from "@/util/process"

/**
 * The watch trigger's one subject for now: a GitHub pull request, read with the user's own `gh`
 * login so a private repository works with no extra credential.
 *
 * Each poll reduces the pull request to a fingerprint of the facts worth waking for: state, head
 * commit, review decision, each check's outcome, and the reviews. A poll whose fingerprint matches
 * the last one costs a `gh` call and nothing else; the model is called only when it differs.
 */

const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?$/

export const isPullRequestUrl = (url: string) => PR_URL.test(url)

export interface Snapshot {
  readonly state: string
  readonly head: string
  readonly reviewDecision: string
  /** name -> outcome, where outcome is the conclusion when finished and the status otherwise. */
  readonly checks: Readonly<Record<string, string>>
  /** One entry per review, `author:state`, in the order GitHub returns them. */
  readonly reviews: readonly string[]
}

type Raw = {
  state?: string
  headRefOid?: string
  reviewDecision?: string | null
  statusCheckRollup?: ReadonlyArray<{
    name?: string
    context?: string
    status?: string
    conclusion?: string | null
    state?: string
  }>
  reviews?: ReadonlyArray<{ author?: { login?: string }; state?: string }>
}

/** PURE. Reduces `gh pr view --json` output to the facts a wake is decided on. */
export function snapshot(raw: Raw): Snapshot {
  const checks: Record<string, string> = {}
  for (const check of raw.statusCheckRollup ?? []) {
    const name = check.name ?? check.context
    if (!name) continue
    // CheckRun carries status+conclusion, StatusContext carries state.
    checks[name] = (check.conclusion || check.state || check.status || "").toLowerCase()
  }
  return {
    state: (raw.state ?? "").toLowerCase(),
    head: raw.headRefOid ?? "",
    reviewDecision: (raw.reviewDecision ?? "").toLowerCase(),
    checks,
    reviews: (raw.reviews ?? []).map(
      (review) => `${review.author?.login ?? "?"}:${(review.state ?? "").toLowerCase()}`,
    ),
  }
}

/** PURE. Stable across key order, so the same facts always give the same string. */
export function fingerprint(snap: Snapshot): string {
  const checks = Object.keys(snap.checks)
    .sort()
    .map((name) => `${name}=${snap.checks[name]}`)
  return JSON.stringify([snap.state, snap.head, snap.reviewDecision, checks, snap.reviews])
}

/** PURE. A merged or closed pull request has nothing left to watch. */
export const isFinished = (snap: Snapshot) => snap.state === "merged" || snap.state === "closed"

/** PURE. One line per fact that differs, for the prompt's WHAT CHANGED section. */
export function describeChange(before: Snapshot | undefined, after: Snapshot): string {
  if (!before) return `Pull request is ${after.state}; review decision ${after.reviewDecision || "none"}.`
  const lines: string[] = []
  if (before.state !== after.state) lines.push(`State: ${before.state} -> ${after.state}`)
  if (before.head !== after.head) lines.push(`New head commit: ${after.head.slice(0, 12)}`)
  if (before.reviewDecision !== after.reviewDecision) {
    lines.push(`Review decision: ${before.reviewDecision || "none"} -> ${after.reviewDecision || "none"}`)
  }
  for (const name of Object.keys(after.checks).sort()) {
    if (before.checks[name] !== after.checks[name]) {
      lines.push(`Check ${name}: ${before.checks[name] ?? "absent"} -> ${after.checks[name]}`)
    }
  }
  if (after.reviews.length > before.reviews.length) {
    lines.push(`New reviews: ${after.reviews.slice(before.reviews.length).join(", ")}`)
  }
  return lines.length > 0 ? lines.join("\n") : "The pull request changed."
}

/** Parses a stored fingerprint back into a snapshot, or undefined when it is absent or malformed. */
export function parseFingerprint(value: string | null | undefined): Snapshot | undefined {
  if (!value) return undefined
  try {
    const [state, head, reviewDecision, checks, reviews] = JSON.parse(value) as [
      string,
      string,
      string,
      string[],
      string[],
    ]
    const record: Record<string, string> = {}
    for (const entry of checks) {
      const at = entry.indexOf("=")
      if (at > 0) record[entry.slice(0, at)] = entry.slice(at + 1)
    }
    return { state, head, reviewDecision, checks: record, reviews }
  } catch {
    return undefined
  }
}

export class WatchError extends Error {}

/** Reads the pull request once through `gh`. Fails with a readable message; never dies. */
export const readPullRequest = (url: string, cwd: string) =>
  Effect.tryPromise({
    try: async () => {
      const out = await Process.text(
        ["gh", "pr", "view", url, "--json", "state,headRefOid,reviewDecision,statusCheckRollup,reviews"],
        { cwd, nothrow: true, timeout: 60_000 },
      )
      if (out.code !== 0) throw new WatchError(out.stderr.toString().trim() || `gh exited ${out.code}`)
      return snapshot(JSON.parse(out.text) as Raw)
    },
    catch: (error) => (error instanceof WatchError ? error : new WatchError(String(error))),
  })

export * as RoutineWatch from "./watch"
