import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { SLOT_NAMES, chooseBench, key, type Candidate } from "./bench"
import { compare, detectProject, runChecks, runSetup, type CheckResult, type Project } from "./checks"
import { measure, type DiffStats } from "./diffstats"
import type { Engine } from "./engine"
import * as Git from "./git"
import { inspect, type Flag } from "./guard"
import { shell } from "./proc"
import { median, percentile, score, type Quality } from "./quality"
import { redact } from "./redact"
import { builderPrompt, parseReview, reviewPrompt, type Evidence, type ReviewAnswer } from "./review"
import { loadRecord, readStandard, recordPreference, saveRecord, stateDir, worktreeRoot } from "./store"
import { combine, consensus, pairs, rank, type PairOutcome, type Standing, type Vote } from "./tournament"

/**
 * The blind build-off.
 *
 *   bench -> worktrees -> baseline checks -> builders (in parallel) -> verify -> tournament -> gate
 *         -> escalate if the gate failed and budget remains -> ready
 *
 * The result handed out is ANONYMOUS: slots A, B, C. Which model built which slot lives only in the
 * record under `.git/redrob/contests/`, and `reveal` is the one function that reads it back -- after the
 * choice has been written to the preference log.
 */

export type ContestOptions = {
  directory: string
  task: string
  builders?: number
  reviewers?: number
  prefer?: string[]
  budgetUsd?: number
  minutes?: number
  /** Percentile of the repo's own human commits the winner must reach. 90 to start, 99 is the target. */
  gatePercentile?: number
  /** Share of pairs the winner must take outright. */
  gateConsensus?: number
  /** Add a builder and re-judge when the gate fails, while budget remains. */
  escalate?: boolean
  /** Only models from these provider ids take part, e.g. ["redrob"] or a person's own keys. */
  providers?: string[]
  /** Commit to start from instead of HEAD. */
  base?: string
  /**
   * The human distribution to rank against, when the repository the contest runs in is not the one
   * whose history matters. Replay runs in a history-free snapshot (so builders cannot read the answer
   * from `git log`) and passes the real repository's distribution here.
   */
  history?: { scores: number[]; referenceSize: number }
  checkTimeoutMs?: number
  historyLimit?: number
  root?: string
  random?: () => number
  onEvent?: (event: ContestEvent) => void
}

export type ContestEvent =
  | { type: "stage"; stage: Stage; detail?: string }
  | { type: "candidate"; slot: string; status: string; costUsd?: number; tools?: number }
  | { type: "note"; message: string }

export type Stage =
  | "preparing"
  | "baseline"
  | "building"
  | "verifying"
  | "reviewing"
  | "gating"
  | "escalating"
  | "ready"

export type CandidateReport = {
  slot: string
  status: "done" | "over_budget" | "timeout" | "error" | "no_change"
  changed: boolean
  files: { path: string; status: string }[]
  added: number
  removed: number
  checks: { name: string; passed: boolean; baselinePassed: boolean | null; output: string }[]
  crossTests: { passed: number; total: number } | null
  reproductionTests: string[]
  quality: Quality
  percentile: number | null
  flags: Flag[]
  flagsAccepted: boolean
  disqualified: string | null
  costUsd: number
  durationMs: number
  points: number
  summary: string
}

export type Gate = { name: string; passed: boolean; detail: string }

export type ContestResult = {
  id: string
  repo: string
  base: string
  task: string
  status: "passed" | "below_standard" | "failed"
  winner: string | null
  ranking: string[]
  candidates: CandidateReport[]
  outcomes: PairOutcome[]
  gates: Gate[]
  neutral: boolean
  notes: string[]
  costUsd: number
  reviewCostUsd: number
  rounds: number
  history: { commits: number; p50: number | null; p90: number | null; p99: number | null }
}

type Private = {
  result: ContestResult
  models: Record<string, string>
  vendors: Record<string, string>
  reviewers: string[]
  commits: Record<string, string | null>
  worktrees: Record<string, string>
  root: string
  revealed: boolean
  chosen?: string
}

type Built = {
  slot: string
  model: Candidate
  worktree: string
  commit: string | null
  stats: DiffStats
  diff: string
  changes: Git.FileChange[]
  checks: CheckResult[]
  flags: Flag[]
  reproductionTests: string[]
  status: CandidateReport["status"]
  costUsd: number
  durationMs: number
  summary: string
  crossTests: { passed: number; total: number } | null
  quality: Quality
  percentile: number | null
}

const contestId = () => `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await work(items[index]!)
      }
    }),
  )
  return results
}

export async function runContest(engine: Engine, options: ContestOptions): Promise<ContestResult> {
  const emit = options.onEvent ?? (() => {})
  const builders = Math.max(1, Math.min(options.builders ?? 3, SLOT_NAMES.length))
  const budgetUsd = options.budgetUsd ?? 5
  const deadline = Date.now() + (options.minutes ?? 20) * 60_000
  const checkTimeoutMs = options.checkTimeoutMs ?? 10 * 60_000
  const notes: string[] = []
  const note = (message: string) => {
    notes.push(message)
    emit({ type: "note", message })
  }

  emit({ type: "stage", stage: "preparing" })
  const repo = await Git.repoRoot(options.directory)
  const base = options.base ? await Git.resolve(repo, options.base) : await Git.headCommit(repo)
  if (!options.base && !(await Git.isClean(repo)))
    note("uncommitted changes in your checkout are not part of the contest; it starts from HEAD")
  const state = await stateDir(repo)
  const id = contestId()
  const root = path.join(options.root ?? worktreeRoot(), id)
  const standard = readStandard(repo)

  const available = (await engine.models(repo)).filter(
    (model) => !options.providers?.length || options.providers.includes(model.providerID),
  )
  const bench = chooseBench(available, {
    builders,
    reviewers: options.reviewers ?? 2,
    prefer: options.prefer,
    random: options.random,
  })
  for (const message of bench.notes) note(message)
  if (bench.builders.length === 0) throw new Error("No model that can use tools is available to this key.")

  emit({ type: "stage", stage: "baseline" })
  const baseline = path.join(root, "baseline")
  await Git.addWorktree(repo, baseline, base)
  const project = detectProject(baseline)
  if (project.checks.length === 0)
    note("no checks were found in this repository; correctness rests on cross-tests and review")
  const setup = await runSetup(baseline, project, checkTimeoutMs)
  if (!setup.ok) note(`setup failed on the base commit: ${setup.output.split("\n")[0]}`)
  const baselineChecks = setup.ok ? await runChecks(baseline, project, checkTimeoutMs) : []
  const history = options.history ?? (await humanHistory(repo, base, options.historyLimit ?? 40))

  const models: Record<string, string> = {}
  const vendors: Record<string, string> = {}
  const worktrees: Record<string, string> = { baseline }
  const built: Built[] = []
  let spent = 0
  let reviewSpent = 0
  const reviewBudget = budgetUsd * 0.2
  const buildBudget = budgetUsd - reviewBudget

  const build = async (model: Candidate, slot: string, share: number): Promise<Built> => {
    models[slot] = key(model)
    vendors[slot] = model.vendor
    const worktree = path.join(root, slot)
    worktrees[slot] = worktree
    const started = Date.now()
    emit({ type: "candidate", slot, status: "preparing" })
    await Git.addWorktree(repo, worktree, base)
    await runSetup(worktree, project, checkTimeoutMs)
    emit({ type: "candidate", slot, status: "building" })
    const run = await engine
      .run({
        directory: worktree,
        model,
        text: builderPrompt({ task: options.task, standard }),
        budgetUsd: share,
        timeoutMs: Math.max(60_000, deadline - Date.now()),
        onProgress: (progress) =>
          emit({ type: "candidate", slot, status: "building", costUsd: progress.costUsd, tools: progress.tools }),
      })
      .catch((error: unknown) => ({
        sessionID: "",
        status: "error" as const,
        costUsd: 0,
        text: "",
        tools: 0,
        error: String(error),
      }))
    spent += run.costUsd
    // Copied test files from a previous cross-test never exist here yet; the worktree is the builder's own.
    const commit = await Git.commitCandidate(worktree, `Contest ${id} candidate ${slot}`)
    const diff = commit ? await Git.diff(repo, base, commit) : ""
    const changes = commit ? await Git.changedFiles(repo, base, commit) : []
    const stats = measure(diff)
    const checks = commit ? await runChecks(worktree, project, checkTimeoutMs) : []
    const reproductionTests = changes
      .filter((change) => change.status === "A" && stats.files.find((file) => file.path === change.path)?.isTest)
      .map((change) => change.path)
    const status: CandidateReport["status"] = run.status === "done" && !commit ? "no_change" : run.status
    emit({ type: "candidate", slot, status, costUsd: run.costUsd })
    return {
      slot,
      model,
      worktree,
      commit,
      stats,
      diff,
      changes,
      checks,
      flags: inspect(changes, stats.files),
      reproductionTests,
      status,
      costUsd: run.costUsd,
      durationMs: Date.now() - started,
      summary: redact(run.text || run.error || "").slice(0, 2000),
      crossTests: null,
      quality: { score: 0, components: [] },
      percentile: null,
    }
  }

  emit({ type: "stage", stage: "building" })
  const share = buildBudget / bench.builders.length
  built.push(...(await Promise.all(bench.builders.map((model, index) => build(model, SLOT_NAMES[index]!, share)))))

  let rounds = 1
  let outcomes: PairOutcome[] = []
  let standings: Standing[] = []
  let answers: { reviewer: string; first: string; second: string; answer: ReviewAnswer }[] = []
  let gates: Gate[] = []
  let winner: string | null = null
  let ranking: string[] = []
  const reviewerKeys = bench.reviewers.map(key)
  const validated = new Map<string, boolean>()

  const judge = async () => {
    emit({ type: "stage", stage: "verifying" })
    await crossTest(built, project, checkTimeoutMs, baseline, validated)
    const referenceSize =
      history.referenceSize || median(built.filter((b) => b.commit).map((b) => b.stats.codeAdded)) || 0
    for (const candidate of built) {
      candidate.quality = score(candidate.stats, { referenceSize, checks: compare(baselineChecks, candidate.checks) })
      const diffOnly = score(candidate.stats, { referenceSize }).score
      candidate.percentile = percentile(diffOnly, history.scores)
    }

    emit({ type: "stage", stage: "reviewing" })
    const contenders = built.filter((candidate) => candidate.commit && candidate.status !== "error")
    const evidence = (candidate: Built): Evidence => ({
      diff: redact(candidate.diff),
      checks: candidate.checks.map((check) => ({
        name: check.name,
        passed: check.passed,
        baselinePassed: baselineChecks.find((entry) => entry.name === check.name)?.passed ?? null,
      })),
      crossTests: candidate.crossTests,
      quality: candidate.quality,
      flags: candidate.flags,
    })
    const jobs: { reviewer: Candidate; first: Built; second: Built }[] = []
    for (const [a, b] of pairs(contenders.map((candidate) => candidate.slot))) {
      const x = contenders.find((candidate) => candidate.slot === a)!
      const y = contenders.find((candidate) => candidate.slot === b)!
      // A reviewer never judges a pair its own company built a side of; fall back to every reviewer only
      // when that leaves nobody, and say so.
      let panel = bench.reviewers.filter(
        (reviewer) => reviewer.vendor !== x.model.vendor && reviewer.vendor !== y.model.vendor,
      )
      if (panel.length === 0) {
        panel = bench.reviewers
        note(`no outside reviewer for ${a} vs ${b}; reviewed by a model from one of the builders' companies`)
      }
      for (const reviewer of panel) jobs.push({ reviewer, first: x, second: y }, { reviewer, first: y, second: x })
    }
    const done = new Set(answers.map((entry) => `${entry.reviewer}|${entry.first}|${entry.second}`))
    // Reviewers run in the base worktree under the read-only `plan` agent: the same project config (and
    // so the same providers) as the builders, and nothing they could change.
    const reviewDir = baseline
    const fresh = jobs.filter((job) => !done.has(`${key(job.reviewer)}|${job.first.slot}|${job.second.slot}`))
    const perReview = Math.max(0.05, (reviewBudget - reviewSpent) / Math.max(1, fresh.length))
    const results = await pool(fresh, 4, async (job) => {
      const run = await engine
        .run({
          directory: reviewDir,
          model: job.reviewer,
          agent: "plan",
          text: reviewPrompt({
            task: options.task,
            standard,
            first: evidence(job.first),
            second: evidence(job.second),
          }),
          budgetUsd: perReview,
          timeoutMs: 5 * 60_000,
          deny: ["edit", "external_directory", "bash", "shell"],
        })
        .catch(() => null)
      reviewSpent += run?.costUsd ?? 0
      const answer = run ? parseReview(run.text) : null
      return answer ? { reviewer: key(job.reviewer), first: job.first.slot, second: job.second.slot, answer } : null
    })
    answers = [...answers, ...results.filter((entry): entry is NonNullable<typeof entry> => entry !== null)]
    const failedReviews = results.filter((entry) => entry === null).length
    if (failedReviews) note(`${failedReviews} review(s) gave no usable verdict and count as ties`)

    const votes: Vote[] = answers.map((entry) => ({
      first: entry.first,
      second: entry.second,
      reviewer: entry.reviewer,
      winner: entry.answer.winner === "tie" ? "tie" : entry.answer.winner === "first" ? entry.first : entry.second,
      confidence: entry.answer.confidence,
      reasons: entry.answer.reasons,
    }))
    ;({ outcomes, standings } = combine(
      contenders.map((candidate) => candidate.slot),
      votes,
      reviewerKeys,
    ))

    emit({ type: "stage", stage: "gating" })
    const quality = Object.fromEntries(built.map((candidate) => [candidate.slot, candidate.quality.score]))
    const ranked = rank(standings, quality)
    ranking = ranked.map((standing) => standing.slot)
    const accepted = (candidate: Built) => {
      if (candidate.flags.length === 0) return true
      const seen = answers.filter((entry) => entry.first === candidate.slot || entry.second === candidate.slot)
      return (
        seen.length > 0 &&
        seen.every((entry) =>
          entry.first === candidate.slot ? entry.answer.acceptTestChanges.first : entry.answer.acceptTestChanges.second,
        )
      )
    }
    const disqualified = (candidate: Built) => {
      if (!candidate.commit) return "made no change"
      if (candidate.status === "error") return "the builder failed"
      if (!accepted(candidate)) return "changed tests in a way reviewers did not accept"
      return null
    }
    const top = ranked
      .map((standing) => built.find((candidate) => candidate.slot === standing.slot)!)
      .find((candidate) => !disqualified(candidate))
    winner = top?.slot ?? null
    gates = top
      ? gate(
          top,
          baselineChecks,
          consensus(
            standings.find((s) => s.slot === top.slot),
            contenders.length,
          ),
          history,
          options,
        )
      : []
    return { disqualified, accepted }
  }

  let verdict = await judge()
  const escalate = options.escalate ?? true
  while (
    escalate &&
    rounds < 2 &&
    (!winner || gates.some((entry) => !entry.passed)) &&
    Date.now() < deadline - 120_000
  ) {
    const remaining = buildBudget - spent
    const used = new Set(built.map((candidate) => key(candidate.model)))
    const usedVendors = new Set(built.map((candidate) => candidate.model.vendor))
    const extra =
      available.find(
        (model) => !used.has(key(model)) && !usedVendors.has(model.vendor) && !reviewerKeys.includes(key(model)),
      ) ?? available.find((model) => !used.has(key(model)) && !reviewerKeys.includes(key(model)))
    if (!extra || remaining < share * 0.5 || built.length >= SLOT_NAMES.length) break
    rounds++
    emit({
      type: "stage",
      stage: "escalating",
      detail: "the best candidate did not clear every gate; adding a builder",
    })
    note(
      `escalated: round ${rounds} added a builder because ${
        gates
          .filter((entry) => !entry.passed)
          .map((entry) => entry.name)
          .join(", ") || "no candidate qualified"
      }`,
    )
    built.push(await build(extra, SLOT_NAMES[built.length]!, Math.min(share, remaining)))
    verdict = await judge()
  }

  const passed = winner !== null && gates.every((entry) => entry.passed)
  const result: ContestResult = {
    id,
    repo,
    base,
    task: options.task,
    status: winner === null ? "failed" : passed ? "passed" : "below_standard",
    winner,
    ranking,
    candidates: built.map((candidate) => ({
      slot: candidate.slot,
      status: candidate.status,
      changed: Boolean(candidate.commit),
      files: candidate.changes.map((change) => ({ path: change.path, status: change.status })),
      added: candidate.stats.added,
      removed: candidate.stats.removed,
      checks: candidate.checks.map((check) => ({
        name: check.name,
        passed: check.passed,
        baselinePassed: baselineChecks.find((entry) => entry.name === check.name)?.passed ?? null,
        output: check.passed ? "" : redact(check.output.split("\n").slice(-20).join("\n")),
      })),
      crossTests: candidate.crossTests,
      reproductionTests: candidate.reproductionTests,
      quality: candidate.quality,
      percentile: candidate.percentile,
      flags: candidate.flags,
      flagsAccepted: verdict.accepted(candidate),
      disqualified: verdict.disqualified(candidate),
      costUsd: round(candidate.costUsd),
      durationMs: candidate.durationMs,
      points: standings.find((standing) => standing.slot === candidate.slot)?.points ?? 0,
      summary: candidate.summary,
    })),
    // Reviewers are anonymous too: which companies review says which ones are NOT building.
    outcomes: outcomes.map((outcome) => ({
      ...outcome,
      verdicts: outcome.verdicts.map((verdict) => ({
        ...verdict,
        reviewer: `R${reviewerKeys.indexOf(verdict.reviewer) + 1}`,
      })),
    })),
    gates,
    neutral: bench.neutral,
    notes,
    costUsd: round(spent + reviewSpent),
    reviewCostUsd: round(reviewSpent),
    rounds,
    history: {
      commits: history.scores.length,
      p50: quantile(history.scores, 0.5),
      p90: quantile(history.scores, 0.9),
      p99: quantile(history.scores, 0.99),
    },
  }

  // Candidates stay reachable by ref after their worktrees go, so a loser can still be inspected.
  for (const candidate of built)
    if (candidate.commit) await Git.keepRef(repo, `refs/redrob/contest/${id}/${candidate.slot}`, candidate.commit)
  const record: Private = {
    result,
    models,
    vendors,
    reviewers: reviewerKeys,
    commits: Object.fromEntries(built.map((candidate) => [candidate.slot, candidate.commit])),
    worktrees,
    root,
    revealed: false,
  }
  saveRecord(state, id, record)
  for (const directory of Object.values(worktrees)) await Git.removeWorktree(repo, directory)
  rmSync(root, { recursive: true, force: true })
  emit({ type: "stage", stage: "ready" })
  return result
}

function gate(
  winner: Built,
  baseline: CheckResult[],
  agreement: number,
  history: { scores: number[] },
  options: ContestOptions,
): Gate[] {
  const delta = compare(baseline, winner.checks)
  const cross = winner.crossTests
  const target = options.gatePercentile ?? 90
  const needed = options.gateConsensus ?? 0.5
  // A majority, not all: a rival's test can itself be wrong, and one wrong rival must not sink a correct
  // candidate. Test-voting across builders is what makes the others' tests evidence at all.
  const crossOk = !cross || cross.total === 0 || cross.passed * 2 >= cross.total
  const gates: Gate[] = [
    {
      name: "correctness",
      passed: delta.regressions === 0 && crossOk,
      detail:
        delta.regressions > 0
          ? `${delta.regressions} check(s) that passed before now fail`
          : cross && cross.total > 0
            ? `${cross.passed}/${cross.total} rival reproduction tests pass (a majority is required)`
            : "no check regressed; no rival reproduction tests to run",
    },
  ]
  if (history.scores.length >= 5 && winner.percentile !== null) {
    gates.push({
      name: "quality",
      passed: winner.percentile >= target,
      detail: `quality at the ${winner.percentile}th percentile of this repo's recent human commits (target ${target})`,
    })
  } else {
    gates.push({
      name: "quality",
      passed: winner.quality.score >= 80,
      detail: `not enough history to rank against; quality score ${winner.quality.score}/100 (target 80)`,
    })
  }
  gates.push({
    name: "consensus",
    passed: agreement >= needed,
    detail: `won ${Math.round(agreement * 100)}% of its pairs outright (target ${Math.round(needed * 100)}%)`,
  })
  return gates
}

/**
 * Runs every candidate against every OTHER builder's new test files. A candidate that passes tests its
 * rivals wrote from the same task is strong evidence it does what the task asked.
 */
async function crossTest(
  built: Built[],
  project: Project,
  timeoutMs: number,
  baseline: string,
  validated: Map<string, boolean>,
) {
  const command = project.testFiles
  if (!command) {
    for (const candidate of built) candidate.crossTests = null
    return
  }
  // A reproduction test proves something only if it FAILS on the base commit: one that already passes
  // there tests nothing the task changed, and would let any candidate look correct.
  for (const other of built) {
    if (!other.commit) continue
    for (const file of other.reproductionTests) {
      const id = `${other.slot}:${file}`
      if (validated.has(id)) continue
      const target = path.join(baseline, file)
      if (existsSync(target)) {
        validated.set(id, false)
        continue
      }
      mkdirSync(path.dirname(target), { recursive: true })
      copyFileSync(path.join(other.worktree, file), target)
      const result = await shell(command([file]), baseline, timeoutMs)
      rmSync(target, { force: true })
      validated.set(id, result.code !== 0)
    }
  }
  for (const candidate of built) {
    if (!candidate.commit) {
      candidate.crossTests = null
      continue
    }
    const foreign = built
      .filter((other) => other !== candidate && other.commit)
      .flatMap((other) =>
        other.reproductionTests
          .filter((file) => validated.get(`${other.slot}:${file}`))
          .map((file) => ({ other, file })),
      )
    let passed = 0
    let total = 0
    for (const { other, file } of foreign) {
      const target = path.join(candidate.worktree, file)
      if (existsSync(target)) continue // its own file at the same path: not a foreign test
      const source = path.join(other.worktree, file)
      if (!existsSync(source)) continue
      mkdirSync(path.dirname(target), { recursive: true })
      copyFileSync(source, target)
      total++
      const result = await shell(command([file]), candidate.worktree, timeoutMs)
      if (result.code === 0) passed++
      rmSync(target, { force: true })
    }
    candidate.crossTests = total > 0 ? { passed, total } : null
  }
}

export async function humanHistory(repo: string, base: string, limit: number) {
  // Commits the contest itself produced are not the human bar, so they are left out.
  const commits = (await Git.history(repo, base, limit)).filter((commit) => !/^Redrob-Model:/m.test(commit.body))
  const scores: number[] = []
  const sizes: number[] = []
  for (const commit of commits) {
    const stats = measure(await Git.commitPatch(repo, commit.sha))
    if (stats.codeAdded === 0 && stats.testAdded === 0) continue
    sizes.push(stats.codeAdded)
  }
  const referenceSize = median(sizes.filter((size) => size > 0))
  for (const commit of commits) {
    const stats = measure(await Git.commitPatch(repo, commit.sha))
    if (stats.codeAdded === 0 && stats.testAdded === 0) continue
    scores.push(score(stats, { referenceSize }).score)
  }
  return { scores, referenceSize }
}

function quantile(values: number[], q: number) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}

const round = (value: number) => Math.round(value * 10_000) / 10_000

/* ---------------------------------------------------------------- pick, reveal, apply */

export type Reveal = { slot: string; model: string; vendor: string; quality: number; points: number; costUsd: number }[]

/**
 * Records the person's choice, then -- and only then -- returns which model built every slot.
 * The preference line is written first so the reveal cannot influence it.
 */
export async function pick(directory: string, id: string, slot: string, reasons: string[] = []): Promise<Reveal> {
  const repo = await Git.repoRoot(directory)
  const state = await stateDir(repo)
  const record = loadRecord<Private>(state, id)
  const chosen = record.result.candidates.find((candidate) => candidate.slot === slot)
  if (!chosen) throw new Error(`Contest ${id} has no candidate ${slot}.`)
  if (!chosen.changed) throw new Error(`Candidate ${slot} made no change.`)
  if (!record.revealed) {
    recordPreference(state, {
      contest: id,
      time: Date.now(),
      task: record.result.task.slice(0, 500),
      chosen: slot,
      chosenModel: record.models[slot]!,
      judgeWinner: record.result.winner,
      judgeWinnerModel: record.result.winner ? record.models[record.result.winner]! : null,
      candidates: record.result.candidates.map((candidate) => ({
        slot: candidate.slot,
        model: record.models[candidate.slot]!,
        quality: candidate.quality.score,
        points: candidate.points,
      })),
      reasons,
    })
  }
  record.revealed = true
  record.chosen = slot
  saveRecord(state, id, record)
  return record.result.candidates.map((candidate) => ({
    slot: candidate.slot,
    model: record.models[candidate.slot]!,
    vendor: record.vendors[candidate.slot]!,
    quality: candidate.quality.score,
    points: candidate.points,
    costUsd: candidate.costUsd,
  }))
}

export type ApplyResult = { strategy: "branch" | "commit"; branch: string | null; commit: string }

/**
 * Puts the chosen candidate into the repository with its provenance on the commit:
 *   Redrob-Model, Redrob-Provider, Redrob-Contest
 * Names are hidden while choosing; they are always recorded after. "branch" (the default) creates
 * `redrob/contest-<id>` and touches nothing else; "commit" cherry-picks onto the current branch and
 * needs a clean checkout.
 */
export async function apply(
  directory: string,
  id: string,
  strategy: "branch" | "commit" = "branch",
): Promise<ApplyResult> {
  const repo = await Git.repoRoot(directory)
  const state = await stateDir(repo)
  const record = loadRecord<Private>(state, id)
  if (!record.revealed || !record.chosen) throw new Error("Pick a candidate before applying it.")
  const slot = record.chosen
  const commit = record.commits[slot]
  if (!commit) throw new Error(`Candidate ${slot} made no change.`)
  const [provider, ...rest] = record.models[slot]!.split("/")
  const subject = summarise(record.result.task)
  const message = [
    subject,
    "",
    `Chosen in a blind build-off of ${record.result.candidates.filter((candidate) => candidate.changed).length} candidates.`,
    "",
    `Redrob-Model: ${rest.join("/")}`,
    `Redrob-Provider: ${provider}`,
    `Redrob-Contest: ${id}`,
    "",
  ].join("\n")
  const stamped = await Git.rewriteMessage(repo, commit, message)
  if (strategy === "branch") {
    const branch = `redrob/contest-${id}`
    await Git.createBranch(repo, branch, stamped)
    return { strategy, branch, commit: stamped }
  }
  if (!(await Git.isClean(repo)))
    throw new Error("Your checkout has uncommitted changes; commit or stash them, or apply as a branch.")
  // HEAD may have moved since the contest started; the cherry-pick still applies when nothing conflicts.
  await Git.cherryPick(repo, stamped)
  return { strategy, branch: await Git.currentBranch(repo), commit: await Git.headCommit(repo) }
}

function summarise(task: string) {
  const line =
    task
      .split(/\r?\n/)
      .find((entry) => entry.trim())
      ?.trim() ?? "Apply build-off winner"
  return line.length > 72 ? `${line.slice(0, 69)}...` : line
}

/**
 * The full record, names included. For the Quality Lab, which scores a contest after the fact and is
 * never shown to a person choosing. Anything that faces a chooser must use `load` instead.
 */
export async function unblindedRecord(directory: string, id: string) {
  const repo = await Git.repoRoot(directory)
  const record = loadRecord<Private>(await stateDir(repo), id)
  return {
    result: record.result,
    models: record.models,
    vendors: record.vendors,
    reviewers: record.reviewers,
    commits: record.commits,
  }
}

/** The last record's anonymous result, for a caller that lost it (the CLI's `--show`). */
export async function load(directory: string, id: string) {
  const repo = await Git.repoRoot(directory)
  return loadRecord<Private>(await stateDir(repo), id).result
}

/** A task given as text, or as `@path/to/file` to read it from a file. */
export function readTask(value: string) {
  return value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value
}
