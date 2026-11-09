import { createHash } from "node:crypto"
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

/** How long one poll may take before it counts as a failed read. */
const READ_TIMEOUT_MS = 60_000

/** Reads the pull request once through `gh`. Fails with a readable message; never dies. */
export const readPullRequest = (url: string, cwd: string) =>
  Effect.tryPromise({
    try: async () => {
      const out = await Process.text(
        ["gh", "pr", "view", url, "--json", "state,headRefOid,reviewDecision,statusCheckRollup,reviews"],
        { cwd, nothrow: true, abort: AbortSignal.timeout(READ_TIMEOUT_MS) },
      )
      if (out.code !== 0) throw new WatchError(out.stderr.toString().trim() || `gh exited ${out.code}`)
      return snapshot(JSON.parse(out.text) as Raw)
    },
    catch: (error) => (error instanceof WatchError ? error : new WatchError(String(error))),
  })

// ---- every kind -------------------------------------------------------------------------------

/** What one watch polls, checked. */
export type Subject =
  | { readonly kind: "github_pr"; readonly url: string }
  | { readonly kind: "ci_run"; readonly url: string }
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "command"; readonly command: string }

/** A GitHub Actions run: `https://github.com/<owner>/<repo>/actions/runs/<id>`, optionally `/job/<n>` or `/attempts/<n>`. */
const RUN_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/actions\/runs\/(\d+)(?:\/(?:job|attempts)\/\d+)?\/?$/

export const MAX_COMMAND_LENGTH = 4000

/** PURE. Checks a watch's fields and returns its subject, or what is wrong in words. */
export function subject(input: { kind: string; url?: string; command?: string }): Subject | string {
  const url = input.url?.trim().replace(/\/$/, "")
  switch (input.kind) {
    case "github_pr":
      return url && isPullRequestUrl(url) ? { kind: "github_pr", url } : "watch needs a full GitHub pull request URL."
    case "ci_run":
      return url && RUN_URL.test(url)
        ? { kind: "ci_run", url }
        : "A ci_run watch needs a GitHub Actions run URL (https://github.com/<owner>/<repo>/actions/runs/<id>)."
    case "url": {
      if (!url || url.length > 2048) return "A url watch needs an http(s) URL."
      const parsed = URL.canParse(url) ? new URL(url) : undefined
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return "A url watch needs an http(s) URL."
      return { kind: "url", url }
    }
    case "command": {
      const command = input.command?.trim()
      if (!command) return "A command watch needs `command`."
      if (command.length > MAX_COMMAND_LENGTH || command.includes("\0"))
        return `command must be at most ${MAX_COMMAND_LENGTH} characters.`
      return { kind: "command", command }
    }
  }
  return `Unknown watch kind: ${input.kind}`
}

/** One poll's result. Only `fingerprint` is stored; a wake happens when it differs from the last one. */
export interface Observation {
  readonly fingerprint: string
  /** Nothing left to watch: the pull request is merged or closed, the CI run completed. */
  readonly finished: boolean
  /** Where the subject stands, one short line ("completed/success", "HTTP 200", "exit 0"). */
  readonly state: string
  /** Extra text for the wake prompt, never stored (a command's latest output). */
  readonly detail?: string
}

/** PURE. A fingerprint of flat facts, stable across key order. */
export function factsFingerprint(facts: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.keys(facts)
      .sort()
      .map((key) => [key, facts[key]]),
  )
}

/** PURE. The facts back out of `factsFingerprint`; undefined when absent or malformed. */
export function parseFacts(value: string | null | undefined): Record<string, string> | undefined {
  if (!value) return undefined
  try {
    const entries = JSON.parse(value) as unknown
    if (!Array.isArray(entries)) return undefined
    const facts: Record<string, string> = {}
    for (const entry of entries) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") return undefined
      facts[entry[0]] = entry[1]
    }
    return facts
  } catch {
    return undefined
  }
}

/** PURE. One line per fact that differs. */
export function describeFacts(before: Record<string, string> | undefined, after: Record<string, string>): string[] {
  const lines: string[] = []
  for (const key of Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after)])).sort()) {
    const was = before?.[key]
    const now = after[key]
    if (was !== now) lines.push(`${key}: ${was ?? "absent"} -> ${now ?? "absent"}`)
  }
  return lines
}

type RawRun = {
  status?: string
  conclusion?: string | null
  jobs?: ReadonlyArray<{ name?: string; status?: string; conclusion?: string | null }>
}

/** PURE. A GitHub Actions run (`gh run view --json status,conclusion,jobs`) as facts. */
export function runFacts(raw: RawRun): Record<string, string> {
  const facts: Record<string, string> = {
    status: (raw.status ?? "").toLowerCase(),
    conclusion: (raw.conclusion ?? "").toLowerCase(),
  }
  for (const job of raw.jobs ?? []) {
    if (!job.name) continue
    facts[`job ${job.name}`] = (job.conclusion || job.status || "").toLowerCase()
  }
  return facts
}

const runState = (facts: Record<string, string>) =>
  facts.conclusion ? `${facts.status}/${facts.conclusion}` : facts.status || "unknown"

/** How much of a command's output is kept for the prompt. */
const OUTPUT_TAIL = 2000

/** PURE. A command's result as facts: the exit code and a hash of its output. */
export function commandFacts(code: number, output: string): Record<string, string> {
  const hash = createHash("sha256").update(output).digest("hex").slice(0, 16)
  return { exit: String(code), output: hash }
}

const read = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => (error instanceof WatchError ? error : new WatchError(String(error))),
  })

/** Polls a subject once. Fails with a readable message when it could not be read; never dies. */
export const observe = (target: Subject, cwd: string): Effect.Effect<Observation, WatchError> => {
  switch (target.kind) {
    case "github_pr":
      return readPullRequest(target.url, cwd).pipe(
        Effect.map((snap) => ({
          fingerprint: fingerprint(snap),
          finished: isFinished(snap),
          state: snap.state || "unknown",
        })),
      )
    case "ci_run":
      return read(async () => {
        const [, owner, repo, id] = RUN_URL.exec(target.url)!
        const out = await Process.text(
          ["gh", "run", "view", id!, "--repo", `${owner}/${repo}`, "--json", "status,conclusion,jobs"],
          { cwd, nothrow: true, abort: AbortSignal.timeout(READ_TIMEOUT_MS) },
        )
        if (out.code !== 0) throw new WatchError(out.stderr.toString().trim() || `gh exited ${out.code}`)
        const facts = runFacts(JSON.parse(out.text) as RawRun)
        return { fingerprint: factsFingerprint(facts), finished: facts.status === "completed", state: runState(facts) }
      })
    case "url":
      return read(async () => {
        // Unreachable is a state worth waking for (a deploy coming up or going down), not a failed read.
        const status = await fetch(target.url, { redirect: "follow", signal: AbortSignal.timeout(30_000) }).then(
          async (response) => {
            await response.body?.cancel().catch(() => undefined)
            return String(response.status)
          },
          () => "unreachable",
        )
        const facts = { status }
        return {
          fingerprint: factsFingerprint(facts),
          finished: false,
          state: status === "unreachable" ? "unreachable" : `HTTP ${status}`,
        }
      })
    case "command":
      return read(async () => {
        const shell = process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c"] : ["sh", "-c"]
        const out = await Process.text([...shell, target.command], {
          cwd,
          nothrow: true,
          abort: AbortSignal.timeout(READ_TIMEOUT_MS * 2),
        })
        const output = (out.text + out.stderr.toString()).trim()
        const facts = commandFacts(out.code, output)
        return {
          fingerprint: factsFingerprint(facts),
          finished: false,
          state: `exit ${out.code}`,
          detail: output.slice(-OUTPUT_TAIL),
        }
      })
  }
}

/** PURE. The WHAT CHANGED text for a wake: what differs between the stored fingerprint and this poll. */
export function describe(target: Subject, before: string | undefined, after: Observation): string {
  if (target.kind === "github_pr") {
    const snap = parseFingerprint(after.fingerprint)
    return snap ? describeChange(parseFingerprint(before), snap) : "The pull request changed."
  }
  const facts = parseFacts(after.fingerprint) ?? {}
  const lines = describeFacts(parseFacts(before), facts)
  const label =
    target.kind === "ci_run" ? `CI run ${target.url}` : target.kind === "url" ? target.url : `\`${target.command}\``
  const head = `${label} is now ${after.state}.`
  if (target.kind === "command") {
    const changed = lines.filter((line) => !line.startsWith("output:"))
    if (lines.some((line) => line.startsWith("output:"))) changed.push("The output changed.")
    return [head, ...changed, ...(after.detail ? ["", "Latest output (tail):", after.detail] : [])].join("\n")
  }
  return [head, ...lines].join("\n")
}

/** PURE. A short label for what is watched, for a person ("redrob-labs/redrob-code#12"). */
export function label(target: Subject): string {
  if (target.kind === "command") return target.command.length > 80 ? `${target.command.slice(0, 77)}...` : target.command
  const pr = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(target.url)
  if (target.kind === "github_pr" && pr) return `${pr[1]}/${pr[2]}#${pr[3]}`
  const run = RUN_URL.exec(target.url)
  if (target.kind === "ci_run" && run) return `${run[1]}/${run[2]} CI ${run[3]}`
  return target.url
}

export * as RoutineWatch from "./watch"
