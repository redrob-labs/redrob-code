/**
 * A whole build-off against the REAL engine binary, with a scripted model server standing in for the
 * vendors (test/fixture/repo.ts): three builders from three "companies", two reviewers from two others.
 * Reviewers prefer the better candidate whichever side it is shown on, so a correct tournament must rank
 * the correct, clean candidate first.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { apply, connect, pick, readPreferences, runContest, type ContestEvent } from "../src"
import { stateDir } from "../src/store"
import { engineBinary, engineEnv, startEngine } from "./fixture/engine"
import { VENDORS, createRepo, scriptedVendors } from "./fixture/repo"

const binary = engineBinary()

describe.skipIf(!binary)("blind build-off against the real engine", () => {
  let llm: ReturnType<typeof scriptedVendors>
  let engine: Awaited<ReturnType<typeof startEngine>>
  let work: string
  let repo: string

  beforeAll(async () => {
    llm = scriptedVendors()
    work = mkdtempSync(path.join(process.env["CONTEST_TEST_ROOT"] ?? tmpdir(), "contest-"))
    repo = path.join(work, "repo")
    createRepo(repo, llm)
    engine = await startEngine(binary!, path.join(work, "home"))
  }, 60_000)

  afterAll(() => {
    engine?.stop()
    llm?.stop()
    if (work) rmSync(work, { recursive: true, force: true })
  })

  test("builds blind, verifies, judges, gates, records the choice, reveals, and applies with provenance", async () => {
    const events: ContestEvent[] = []
    const result = await runContest(connect(engine.url, engine.authorization), {
      directory: repo,
      task: "Add a `sub(a, b)` function to src/math.ts that returns a minus b.",
      builders: 3,
      reviewers: 2,
      prefer: ["acme/coder", "beta/coder", "gamma/coder"],
      providers: VENDORS,
      escalate: false,
      root: path.join(work, "worktrees"),
      random: () => 0.99,
      onEvent: (event) => events.push(event),
    })

    // The handed-out result names slots, never models or vendors, builders or reviewers.
    const blob = JSON.stringify(result).toLowerCase()
    for (const vendor of VENDORS) expect(blob).not.toContain(`${vendor}/coder`)

    expect(result.candidates.map((candidate) => candidate.changed)).toEqual([true, true, true])
    const byTest = (name: string) =>
      result.candidates.find((candidate) => candidate.reproductionTests.some((file) => file.includes(name)))!
    const acme = byTest("sub.test")
    const beta = byTest("subtract.test")
    const gamma = byTest("minus.test")

    // gamma's own test check regresses; acme passes every rival reproduction test, gamma none.
    expect(gamma.checks.find((check) => check.name === "test")?.passed).toBe(false)
    expect(acme.checks.every((check) => check.passed)).toBe(true)
    expect(acme.crossTests).toEqual({ passed: 2, total: 2 })
    expect(gamma.crossTests?.passed).toBe(0)
    // beta's debug print and TODO cost it on the automatic score.
    expect(beta.quality.score).toBeLessThan(acme.quality.score)
    expect(beta.quality.components.map((component) => component.name)).toContain("debris")

    // Position-swapped reviews by two outside reviewers put acme first, and it clears every gate.
    expect(result.winner).toBe(acme.slot)
    expect(result.ranking[0]).toBe(acme.slot)
    expect(result.status).toBe("passed")
    expect(result.gates.map((gate) => [gate.name, gate.passed])).toEqual([
      ["correctness", true],
      ["quality", true],
      ["consensus", true],
    ])
    expect(result.neutral).toBe(true)
    expect(result.outcomes.flatMap((outcome) => outcome.verdicts.map((verdict) => verdict.reviewer)).sort()[0]).toBe(
      "R1",
    )
    expect(events.some((event) => event.type === "stage" && event.stage === "reviewing")).toBe(true)
    // 3 pairs x 2 reviewers x 2 orders, and only the reviewer vendors judged.
    expect(llm.calls.filter((call) => call.vendor === "delta" || call.vendor === "eps").length).toBeGreaterThanOrEqual(
      12,
    )

    // The choice is written before the names come back.
    const reveal = await pick(repo, result.id, acme.slot, ["simplest"])
    const preference = readPreferences(await stateDir(repo)).at(-1)!
    expect(preference.chosen).toBe(acme.slot)
    expect(preference.chosenModel).toBe("acme/coder")
    expect(preference.judgeWinnerModel).toBe("acme/coder")
    expect(reveal.find((entry) => entry.slot === acme.slot)?.model).toBe("acme/coder")

    const applied = await apply(repo, result.id, "branch")
    expect(applied.branch).toBe(`redrob/contest-${result.id}`)
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo }).stdout.toString()
    const message = git("log", "-1", "--format=%B", applied.branch!)
    expect(message).toContain("Redrob-Model: coder")
    expect(message).toContain("Redrob-Provider: acme")
    expect(message).toContain(`Redrob-Contest: ${result.id}`)
    expect(git("show", `${applied.branch}:src/math.ts`)).toContain("a - b")
    // The person's own checkout was never touched, and losers stay inspectable by ref.
    expect(readFileSync(path.join(repo, "src", "math.ts"), "utf8")).not.toContain("sub")
    expect(git("rev-parse", "--verify", `refs/redrob/contest/${result.id}/${gamma.slot}`).trim()).toMatch(
      /^[0-9a-f]{40}$/,
    )
    // No worktree is left behind.
    expect(git("worktree", "list").trim().split("\n").length).toBe(1)
  }, 300_000)

  test("redrob buildoff runs the same contest from the command line", async () => {
    const cli = path.join(work, "cli-repo")
    createRepo(cli, llm)
    // Async, never spawnSync: this test process also serves the scripted vendors, and a blocked event
    // loop would leave the CLI waiting on a model that cannot answer.
    const child = Bun.spawn(
      [
        binary!,
        "buildoff",
        "Add a `sub(a, b)` function to src/math.ts that returns a minus b.",
        "--json",
        "--auto",
        "--no-escalate",
        ...["acme", "beta", "gamma"].flatMap((vendor) => ["--model", `${vendor}/coder`]),
        ...VENDORS.flatMap((vendor) => ["--provider", vendor]),
      ],
      {
        cwd: cli,
        env: { ...engineEnv(path.join(work, "cli-home")), REDROB_CONTEST_ROOT: path.join(work, "cli-worktrees") },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timer = setTimeout(() => child.kill(), 240_000)
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timer)
    expect({ exit: await child.exited, stderr: stderr.slice(-500) }).toMatchObject({ exit: 0 })
    const output = JSON.parse(stdout) as {
      result: { status: string; winner: string }
      chosen: string
      reveal: { slot: string; model: string }[]
      applied: { branch: string }
    }
    expect(output.result.status).toBe("passed")
    expect(output.chosen).toBe(output.result.winner)
    expect(output.reveal.find((entry) => entry.slot === output.chosen)?.model).toBe("acme/coder")
    const message = Bun.spawnSync(["git", "log", "-1", "--format=%B", output.applied.branch], {
      cwd: cli,
    }).stdout.toString()
    expect(message).toContain("Redrob-Provider: acme")
  }, 300_000)
})
