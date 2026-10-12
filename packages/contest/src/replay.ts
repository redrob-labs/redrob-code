import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseModel, vendorOf, type Candidate } from "./bench"
import { detectProject, runSetup, type Project } from "./checks"
import { humanHistory, runContest, unblindedRecord, type ContestOptions, type ContestResult } from "./contest"
import { isTestPath, measure } from "./diffstats"
import type { Engine } from "./engine"
import * as Git from "./git"
import { perturbations, type Perturbation } from "./perturb"
import { run, shell } from "./proc"
import { percentile, score } from "./quality"
import { redact } from "./redact"
import { parseReview, reviewPrompt, type Evidence } from "./review"
import { stateDir, worktreeRoot } from "./store"

/**
 * The Quality Lab: the repository's own history used as a benchmark, with no human in the loop.
 *
 *   1. Mine merged fixes whose new or changed tests FAIL on the parent commit and PASS on the fix.
 *   2. Snapshot the parent WITHOUT history, so a builder cannot read the answer from `git log`.
 *   3. Run a full build-off on the commit message as the task.
 *   4. Restore the hidden tests over each candidate and run them: resolved or not.
 *   5. Put the winner head to head with the human's own patch, blind, with the same reviewers.
 *   6. Check the judge with controlled damage to the human patch: it must prefer the original.
 *
 * Every number comes from execution or from position-consistent pairwise votes.
 */

export type ReplayTask = {
  sha: string
  parent: string
  subject: string
  task: string
  hiddenTests: string[]
  codeFiles: string[]
  /** The message says little; the task is harder than it would be from a real issue. */
  weak: boolean
}

export type TaskReport = {
  sha: string
  subject: string
  weak: boolean
  valid: boolean
  reason?: string
  contest?: string
  status?: ContestResult["status"]
  winner?: string | null
  winnerModel?: string | null
  candidates?: { slot: string; model: string; resolved: boolean; quality: number; percentile: number | null }[]
  winnerResolved?: boolean
  human?: { quality: number; percentile: number | null; verdict: "winner" | "human" | "tie" | "unjudged" }
  judge?: { pairs: number; correct: number }
  perturbation?: { kind: Perturbation["kind"]; trials: number; correct: number }[]
  identity?: { trials: number; ties: number }
  costUsd: number
}

export type ReplayMetrics = {
  tasks: number
  /** The share of tasks whose chosen winner passes the hidden tests. */
  resolvedRate: number | null
  /** The share where at least one candidate did: the ceiling a perfect judge would reach. */
  oracleRate: number | null
  /** What one attempt alone gets: the mean resolved rate across all candidates. */
  singleAttemptRate: number | null
  /** Among resolved winners, the share judged level with or better than the human patch. */
  atLeastHumanRate: number | null
  winnerPercentileMedian: number | null
  /** How often the tournament ranked a resolved candidate above an unresolved one. */
  judgeGroundedAccuracy: number | null
  /** How often reviewers preferred the human patch over a damaged copy of it, across all kinds. */
  judgePerturbationAccuracy: number | null
  /** How often an identical pair was called a tie. */
  judgeIdentityRate: number | null
  perModel: Record<string, { tasks: number; resolved: number }>
  costUsd: number
}

export type ReplayReport = {
  repo: string
  time: number
  scanned: number
  mined: number
  tasks: TaskReport[]
  metrics: ReplayMetrics
}

export type ReplayOptions = Omit<ContestOptions, "directory" | "task" | "base" | "history" | "onEvent"> & {
  directory: string
  /** Tasks to run. Mining stops once this many have been validated. */
  limit?: number
  /** Commits to scan for candidate tasks. */
  scan?: number
  /** Check the judge with perturbed human patches. */
  perturb?: boolean
  onEvent?: (event: { type: "task"; sha: string; stage: string; detail?: string }) => void
}

const TRAILER = /^[A-Z][\w-]*: .+$/
const NOT_CODE =
  /\.(md|mdx|txt|rst|json|ya?ml|toml|lock|svg|png|jpe?g|gif|ico|css|scss|html)$|(^|\/)(LICENSE|CHANGELOG|README)/i

export function taskFromMessage(body: string) {
  const lines = body.replace(/\r/g, "").split("\n")
  while (lines.length && (TRAILER.test(lines[lines.length - 1]!.trim()) || lines[lines.length - 1]!.trim() === ""))
    lines.pop()
  const subject = lines[0]?.trim() ?? ""
  const text = lines.join("\n").trim()
  return { subject, task: text, weak: text.length < 40 }
}

export async function mineTasks(
  repo: string,
  options: { scan?: number; maxCodeLines?: number } = {},
): Promise<{ scanned: number; tasks: ReplayTask[] }> {
  const commits = await Git.history(repo, "HEAD", options.scan ?? 300)
  const tasks: ReplayTask[] = []
  for (const commit of commits) {
    if (/^Redrob-Model:/m.test(commit.body)) continue
    const parent = await Git.git(repo, ["rev-parse", "--verify", "--quiet", `${commit.sha}^`])
    if (parent.code !== 0) continue
    const changes = await Git.changedFiles(repo, `${commit.sha}^`, commit.sha)
    const hiddenTests = changes
      .filter((change) => (change.status === "A" || change.status === "M") && isTestPath(change.path))
      .map((change) => change.path)
    const codeFiles = changes
      .filter((change) => !isTestPath(change.path) && !NOT_CODE.test(change.path))
      .map((change) => change.path)
    if (hiddenTests.length === 0 || codeFiles.length === 0) continue
    const stats = measure(await Git.commitPatch(repo, commit.sha))
    if (stats.codeAdded > (options.maxCodeLines ?? 400)) continue
    const message = taskFromMessage(commit.body)
    if (!message.task) continue
    tasks.push({
      sha: commit.sha,
      parent: parent.stdout.trim(),
      subject: message.subject,
      task: message.task,
      hiddenTests,
      codeFiles,
      weak: message.weak,
    })
  }
  return { scanned: commits.length, tasks }
}

/** The tree at `commit` as a brand-new one-commit repository: no history, nothing to read the answer from. */
export async function snapshot(repo: string, commit: string, directory: string) {
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  // Checked out with a throwaway index rather than piped through `tar`: Git Bash's tar reads `C:\...` as
  // a remote host, and a private GIT_INDEX_FILE leaves the real repository's index and HEAD untouched.
  const index = `${directory}.index`
  const extracted = await run("git", ["--work-tree", directory, "checkout", commit, "--", "."], {
    cwd: repo,
    env: { ...process.env, GIT_INDEX_FILE: index },
  })
  rmSync(index, { force: true })
  if (extracted.code !== 0) throw new Error(`extracting ${commit.slice(0, 9)} failed: ${extracted.stderr}`)
  const git = (...args: string[]) =>
    run(
      "git",
      ["-c", "user.name=Redrob Code", "-c", "user.email=contest@code.redrob.ai", "-c", "commit.gpgsign=false", ...args],
      { cwd: directory },
    )
  await git("init", "-q", "-b", "main")
  await git("add", "-A")
  await git("commit", "-q", "--no-verify", "-m", "Snapshot")
}

async function writeFromCommit(repo: string, sha: string, files: string[], directory: string) {
  for (const file of files) {
    const shown = await run("git", ["show", `${sha}:${file}`], { cwd: repo })
    if (shown.code !== 0) continue
    const target = path.join(directory, file)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, shown.stdout)
  }
}

async function resetTo(directory: string, ref: string) {
  await run("git", ["checkout", "-q", "--force", ref], { cwd: directory })
  // -fd keeps ignored files, so installed dependencies survive between candidates.
  await run("git", ["clean", "-q", "-fd"], { cwd: directory })
}

async function hiddenPass(directory: string, project: Project, files: string[], timeoutMs: number) {
  const result = await shell(project.testFiles!(files), directory, timeoutMs)
  return result.code === 0
}

/** fail on the parent, pass on the fix: otherwise the hidden tests do not measure the change. */
export async function validate(repo: string, task: ReplayTask, directory: string, project: Project, timeoutMs: number) {
  if (!project.testFiles) return { valid: false, reason: "no test runner that can run single files was found" }
  await writeFromCommit(repo, task.sha, task.hiddenTests, directory)
  const before = await hiddenPass(directory, project, task.hiddenTests, timeoutMs)
  await resetTo(directory, "main")
  if (before) return { valid: false, reason: "the hidden tests already pass before the fix" }
  const patch = path.join(path.dirname(directory), `${path.basename(directory)}.patch`)
  writeFileSync(patch, await Git.commitPatch(repo, task.sha))
  const applied = await run("git", ["apply", "--whitespace=nowarn", patch], { cwd: directory })
  rmSync(patch, { force: true })
  if (applied.code !== 0) {
    await resetTo(directory, "main")
    return { valid: false, reason: "the human patch does not apply to its own parent snapshot" }
  }
  const after = await hiddenPass(directory, project, task.hiddenTests, timeoutMs)
  await resetTo(directory, "main")
  if (!after) return { valid: false, reason: "the hidden tests do not pass with the human patch" }
  return { valid: true }
}

type ReviewerRef = Candidate

async function pairVerdict(
  engine: Engine,
  directory: string,
  reviewers: ReviewerRef[],
  task: string,
  original: Evidence,
  other: Evidence,
): Promise<{ verdicts: ("original" | "other" | "tie")[]; costUsd: number }> {
  let costUsd = 0
  const verdicts: ("original" | "other" | "tie")[] = []
  for (const reviewer of reviewers) {
    const ask = async (first: Evidence, second: Evidence) => {
      const result = await engine
        .run({
          directory,
          model: reviewer,
          agent: "plan",
          text: reviewPrompt({ task, standard: null, first, second }),
          budgetUsd: 0.5,
          timeoutMs: 5 * 60_000,
          deny: ["edit", "external_directory", "bash", "shell"],
        })
        .catch(() => null)
      costUsd += result?.costUsd ?? 0
      return result ? parseReview(result.text) : null
    }
    const a = await ask(original, other)
    const b = await ask(other, original)
    const pickA = a?.winner === "first" ? "original" : a?.winner === "second" ? "other" : "tie"
    const pickB = b?.winner === "first" ? "other" : b?.winner === "second" ? "original" : "tie"
    verdicts.push(a && b && pickA === pickB ? pickA : "tie")
  }
  return { verdicts, costUsd }
}

const evidenceOf = (diff: string, quality: number): Evidence => ({
  diff: redact(diff),
  checks: [],
  crossTests: null,
  quality: { score: quality, components: [] },
  flags: [],
})

export async function runReplay(engine: Engine, options: ReplayOptions): Promise<ReplayReport> {
  const emit = options.onEvent ?? (() => {})
  const repo = await Git.repoRoot(options.directory)
  const timeoutMs = options.checkTimeoutMs ?? 10 * 60_000
  const mined = await mineTasks(repo, { scan: options.scan })
  const root = path.join(options.root ?? worktreeRoot(), `replay-${Date.now().toString(36)}`)
  const reports: TaskReport[] = []
  const limit = options.limit ?? 10

  for (const task of mined.tasks) {
    if (reports.filter((report) => report.valid).length >= limit) break
    const id = task.sha.slice(0, 10)
    const directory = path.join(root, id)
    emit({ type: "task", sha: task.sha, stage: "snapshot", detail: task.subject })
    await snapshot(repo, task.parent, directory)
    const project = detectProject(directory)
    const setup = await runSetup(directory, project, timeoutMs)
    if (!setup.ok) {
      reports.push({
        sha: task.sha,
        subject: task.subject,
        weak: task.weak,
        valid: false,
        reason: "setup failed on the parent",
        costUsd: 0,
      })
      continue
    }
    const check = await validate(repo, task, directory, project, timeoutMs)
    if (!check.valid) {
      reports.push({
        sha: task.sha,
        subject: task.subject,
        weak: task.weak,
        valid: false,
        reason: check.reason,
        costUsd: 0,
      })
      continue
    }

    emit({ type: "task", sha: task.sha, stage: "build-off" })
    const history = await humanHistory(repo, task.parent, options.historyLimit ?? 40)
    const { onEvent: _onEvent, limit: _limit, scan: _scan, perturb: _perturb, ...contest } = options
    const result = await runContest(engine, {
      ...contest,
      directory,
      task: task.task,
      history,
      root: path.join(root, `${id}-wt`),
      escalate: options.escalate ?? false,
    })
    const record = await unblindedRecord(directory, result.id)

    emit({ type: "task", sha: task.sha, stage: "hidden tests" })
    const candidates: NonNullable<TaskReport["candidates"]> = []
    for (const candidate of result.candidates) {
      let resolved = false
      if (candidate.changed) {
        await resetTo(directory, `refs/redrob/contest/${result.id}/${candidate.slot}`)
        await writeFromCommit(repo, task.sha, task.hiddenTests, directory)
        resolved = await hiddenPass(directory, project, task.hiddenTests, timeoutMs)
        await resetTo(directory, "main")
      }
      candidates.push({
        slot: candidate.slot,
        model: record.models[candidate.slot]!,
        resolved,
        quality: candidate.quality.score,
        percentile: candidate.percentile,
      })
    }
    const resolvedSlots = new Set(
      candidates.filter((candidate) => candidate.resolved).map((candidate) => candidate.slot),
    )

    // Grounded agreement: wherever exactly one side of a judged pair passes the hidden tests, the
    // tournament should have preferred that side.
    let pairs = 0
    let correct = 0
    for (const outcome of result.outcomes) {
      const a = resolvedSlots.has(outcome.a)
      const b = resolvedSlots.has(outcome.b)
      if (a === b || outcome.winner === "tie") continue
      pairs++
      if ((outcome.winner === outcome.a && a) || (outcome.winner === outcome.b && b)) correct++
    }

    const reviewers = record.reviewers.map((key) => {
      const ref = parseModel(key)
      return { ...ref, vendor: vendorOf(ref), tools: true }
    })
    const humanDiff = await Git.commitPatch(repo, task.sha)
    const humanQuality = score(measure(humanDiff), { referenceSize: history.referenceSize })
    let cost = result.costUsd
    let verdict: NonNullable<TaskReport["human"]>["verdict"] = "unjudged"
    const winner = result.winner ? result.candidates.find((candidate) => candidate.slot === result.winner) : undefined
    if (winner && resolvedSlots.has(winner.slot) && reviewers.length) {
      emit({ type: "task", sha: task.sha, stage: "head to head with the human patch" })
      const winnerDiff = await Git.diff(directory, "main", `refs/redrob/contest/${result.id}/${winner.slot}`)
      const winnerVendor = record.vendors[winner.slot]
      const panel = reviewers.filter((reviewer) => reviewer.vendor !== winnerVendor)
      const judged = await pairVerdict(
        engine,
        directory,
        panel.length ? panel : reviewers,
        task.task,
        evidenceOf(winnerDiff, winner.quality.score),
        evidenceOf(humanDiff, humanQuality.score),
      )
      cost += judged.costUsd
      const forWinner = judged.verdicts.filter((entry) => entry === "original").length
      const forHuman = judged.verdicts.filter((entry) => entry === "other").length
      verdict = forWinner > forHuman ? "winner" : forHuman > forWinner ? "human" : "tie"
    }

    let perturbation: TaskReport["perturbation"]
    let identity: TaskReport["identity"]
    if ((options.perturb ?? true) && reviewers.length) {
      emit({ type: "task", sha: task.sha, stage: "judge checks" })
      perturbation = []
      const original = evidenceOf(humanDiff, humanQuality.score)
      for (const damaged of perturbations(humanDiff)) {
        const judged = await pairVerdict(
          engine,
          directory,
          reviewers,
          task.task,
          original,
          evidenceOf(damaged.diff, score(measure(damaged.diff), { referenceSize: history.referenceSize }).score),
        )
        cost += judged.costUsd
        perturbation.push({
          kind: damaged.kind,
          trials: judged.verdicts.length,
          correct: judged.verdicts.filter((entry) => entry === "original").length,
        })
      }
      const same = await pairVerdict(engine, directory, reviewers, task.task, original, original)
      cost += same.costUsd
      identity = { trials: same.verdicts.length, ties: same.verdicts.filter((entry) => entry === "tie").length }
    }

    reports.push({
      sha: task.sha,
      subject: task.subject,
      weak: task.weak,
      valid: true,
      contest: result.id,
      status: result.status,
      winner: result.winner,
      winnerModel: result.winner ? record.models[result.winner]! : null,
      candidates,
      winnerResolved: result.winner ? resolvedSlots.has(result.winner) : false,
      human: { quality: humanQuality.score, percentile: percentile(humanQuality.score, history.scores), verdict },
      judge: { pairs, correct },
      perturbation,
      identity,
      costUsd: Math.round(cost * 10_000) / 10_000,
    })
  }
  rmSync(root, { recursive: true, force: true })

  const report: ReplayReport = {
    repo,
    time: Date.now(),
    scanned: mined.scanned,
    mined: mined.tasks.length,
    tasks: reports,
    metrics: summarise(reports),
  }
  const state = await stateDir(repo)
  mkdirSync(path.join(state, "bench"), { recursive: true })
  writeFileSync(path.join(state, "bench", `${report.time}.json`), `${JSON.stringify(report, null, 2)}\n`)
  return report
}

const share = (part: number, whole: number) => (whole === 0 ? null : Math.round((part * 1000) / whole) / 10)

export function summarise(tasks: TaskReport[]): ReplayMetrics {
  const valid = tasks.filter((task) => task.valid && task.candidates)
  const perModel: ReplayMetrics["perModel"] = {}
  let attempts = 0
  let resolvedAttempts = 0
  for (const task of valid) {
    for (const candidate of task.candidates!) {
      perModel[candidate.model] ??= { tasks: 0, resolved: 0 }
      perModel[candidate.model]!.tasks++
      attempts++
      if (candidate.resolved) {
        perModel[candidate.model]!.resolved++
        resolvedAttempts++
      }
    }
  }
  const resolvedWinners = valid.filter((task) => task.winnerResolved)
  const judged = resolvedWinners.filter((task) => task.human && task.human.verdict !== "unjudged")
  const percentiles = valid
    .map((task) => task.candidates!.find((candidate) => candidate.slot === task.winner)?.percentile)
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b)
  const grounded = valid.reduce(
    (sum, task) => ({ pairs: sum.pairs + (task.judge?.pairs ?? 0), correct: sum.correct + (task.judge?.correct ?? 0) }),
    { pairs: 0, correct: 0 },
  )
  const perturbed = valid.flatMap((task) => task.perturbation ?? [])
  const identity = valid.reduce(
    (sum, task) => ({ trials: sum.trials + (task.identity?.trials ?? 0), ties: sum.ties + (task.identity?.ties ?? 0) }),
    { trials: 0, ties: 0 },
  )
  return {
    tasks: valid.length,
    resolvedRate: share(resolvedWinners.length, valid.length),
    oracleRate: share(
      valid.filter((task) => task.candidates!.some((candidate) => candidate.resolved)).length,
      valid.length,
    ),
    singleAttemptRate: share(resolvedAttempts, attempts),
    atLeastHumanRate: share(judged.filter((task) => task.human!.verdict !== "human").length, judged.length),
    winnerPercentileMedian: percentiles.length ? percentiles[Math.floor(percentiles.length / 2)]! : null,
    judgeGroundedAccuracy: share(grounded.correct, grounded.pairs),
    judgePerturbationAccuracy: share(
      perturbed.reduce((sum, entry) => sum + entry.correct, 0),
      perturbed.reduce((sum, entry) => sum + entry.trials, 0),
    ),
    judgeIdentityRate: share(identity.ties, identity.trials),
    perModel,
    costUsd: Math.round(tasks.reduce((sum, task) => sum + task.costUsd, 0) * 10_000) / 10_000,
  }
}

/** The metrics that must not fall between two runs, and how far each may slip before it counts. */
export const GUARDED: { key: keyof ReplayMetrics; tolerance: number }[] = [
  { key: "resolvedRate", tolerance: 5 },
  { key: "atLeastHumanRate", tolerance: 10 },
  { key: "winnerPercentileMedian", tolerance: 5 },
  { key: "judgeGroundedAccuracy", tolerance: 10 },
  { key: "judgePerturbationAccuracy", tolerance: 10 },
  { key: "judgeIdentityRate", tolerance: 15 },
]

export function regressions(current: ReplayMetrics, baseline: Partial<ReplayMetrics>) {
  const found: { metric: string; baseline: number; current: number | null }[] = []
  for (const { key, tolerance } of GUARDED) {
    const before = baseline[key]
    const after = current[key]
    if (typeof before !== "number") continue
    if (typeof after !== "number" || after < before - tolerance)
      found.push({ metric: key, baseline: before, current: typeof after === "number" ? after : null })
  }
  return found
}
