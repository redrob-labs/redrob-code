/**
 * The Quality Lab over a real repository history, against the real engine, with scripted vendors.
 * Every number it reports must come from executing hidden tests or from position-consistent votes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { connect, regressions, runReplay } from "../src"
import { stateDir } from "../src/store"
import { engineBinary, engineEnv, startEngine } from "./fixture/engine"
import { createHistoryRepo, historyVendors } from "./fixture/history"
import { VENDORS } from "./fixture/repo"

const binary = engineBinary()

describe.skipIf(!binary)("replay benchmark against the real engine", () => {
  let llm: ReturnType<typeof historyVendors>
  let engine: Awaited<ReturnType<typeof startEngine>>
  let work: string
  let repo: string

  beforeAll(async () => {
    llm = historyVendors()
    work = mkdtempSync(path.join(process.env["CONTEST_TEST_ROOT"] ?? tmpdir(), "replay-"))
    repo = path.join(work, "repo")
    createHistoryRepo(repo, llm)
    engine = await startEngine(binary!, path.join(work, "home"))
  }, 60_000)

  afterAll(() => {
    engine?.stop()
    llm?.stop()
    if (work) rmSync(work, { recursive: true, force: true })
  })

  test("mines fail-to-pass fixes, replays them blind, and scores winners, the human head-to-head and the judge", async () => {
    const report = await runReplay(connect(engine.url, engine.authorization), {
      directory: repo,
      limit: 5,
      builders: 3,
      reviewers: 2,
      prefer: ["acme/coder", "beta/coder", "gamma/coder"],
      providers: VENDORS,
      root: path.join(work, "replay"),
      random: () => 0.3,
    })

    // Two commits came with a test; the readme and the initial commit are not tasks.
    expect(report.mined).toBe(2)
    expect(report.tasks.map((task) => [task.subject, task.valid])).toEqual([
      ["Add multiply", true],
      ["Add subtract", true],
    ])

    for (const task of report.tasks) {
      const byModel = Object.fromEntries(task.candidates!.map((candidate) => [candidate.model, candidate.resolved]))
      // Hidden tests decide, not anyone's opinion: the wrong implementation fails them.
      expect(byModel).toEqual({ "acme/coder": true, "beta/coder": true, "gamma/coder": false })
      expect(task.winnerModel).toBe("acme/coder")
      expect(task.winnerResolved).toBe(true)
      // Same operator, same tidiness: reviewers call the winner level with the human patch.
      expect(task.human?.verdict).toBe("tie")
      // Every pair with exactly one resolved side was won by that side.
      expect(task.judge!.correct).toBe(task.judge!.pairs)
      expect(task.judge!.pairs).toBeGreaterThan(0)
      // The judge preferred the human patch over every damaged copy, and tied identical ones.
      // Which damage applies depends on the patch; both of these one-line fixes take a bug, debris and a skip.
      expect(task.perturbation!.map((entry) => entry.kind).sort()).toEqual(["bug", "debris", "test-skip"])
      for (const entry of task.perturbation!) expect(entry.correct).toBe(entry.trials)
      expect(task.identity).toEqual({ trials: 2, ties: 2 })
    }

    expect(report.metrics).toMatchObject({
      tasks: 2,
      resolvedRate: 100,
      oracleRate: 100,
      atLeastHumanRate: 100,
      judgeGroundedAccuracy: 100,
      judgePerturbationAccuracy: 100,
      judgeIdentityRate: 100,
    })
    // Best of three beats one attempt on average: 2 of 3 builders were right each time.
    expect(report.metrics.singleAttemptRate).toBe(66.7)
    expect(report.metrics.perModel["gamma/coder"]).toEqual({ tasks: 2, resolved: 0 })

    // The report is kept in the repo's git directory, and a regression gate reads it.
    expect(readdirSync(path.join(await stateDir(repo), "bench")).length).toBe(1)
    expect(regressions(report.metrics, { resolvedRate: 100, judgePerturbationAccuracy: 100 })).toEqual([])
    expect(regressions({ ...report.metrics, resolvedRate: 50 }, { resolvedRate: 100 })).toEqual([
      { metric: "resolvedRate", baseline: 100, current: 50 },
    ])
    // The real checkout was never touched and holds no leftover worktree.
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo }).stdout.toString()
    expect(git("status", "--porcelain").trim()).toBe("")
    expect(git("worktree", "list").trim().split("\n").length).toBe(1)
  }, 600_000)

  test("redrob bench --replay prints the same metrics and fails when they fall below a baseline", async () => {
    const run = async (extra: string[]) => {
      const child = Bun.spawn(
        [
          binary!,
          "bench",
          "--replay",
          "--json",
          "--limit",
          "1",
          "--no-perturb",
          ...["acme", "beta", "gamma"].flatMap((v) => ["--model", `${v}/coder`]),
          ...VENDORS.flatMap((v) => ["--provider", v]),
          ...extra,
        ],
        {
          cwd: repo,
          env: { ...engineEnv(path.join(work, "cli-home")), REDROB_CONTEST_ROOT: path.join(work, "cli-replay") },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const timer = setTimeout(() => child.kill(), 300_000)
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      clearTimeout(timer)
      return { exit: await child.exited, stdout, stderr }
    }
    const baseline = path.join(work, "baseline.json")
    const first = await run(["--save-baseline", baseline])
    expect({ exit: first.exit, stderr: first.stderr.slice(-400) }).toMatchObject({ exit: 0 })
    expect(JSON.parse(first.stdout).metrics.resolvedRate).toBe(100)

    // A baseline the current run cannot meet makes the command fail, which is what blocks CI.
    await Bun.write(
      baseline,
      JSON.stringify({
        metrics: { resolvedRate: 100, oracleRate: 100, singleAttemptRate: 100, winnerPercentileMedian: 1000 },
      }),
    )
    const second = await run(["--baseline", baseline])
    expect(second.exit).toBe(3)
    expect(second.stderr).toContain("winnerPercentileMedian")
  }, 700_000)
})
