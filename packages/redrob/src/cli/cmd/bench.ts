import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { GUARDED, connect, regressions, runReplay, type ReplayMetrics, type ReplayReport } from "@redrob-code/contest"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { startEngine } from "./buildoff"

/**
 * `redrob bench --replay`: this repository's own history as a benchmark.
 *
 * Mines merged fixes whose tests fail before and pass after, replays each as a blind build-off in a
 * history-free snapshot, runs the hidden tests over every candidate, puts the winner head to head with
 * the human patch, and checks the judge against damaged copies of that patch. Nothing waits on a
 * person. `--baseline` turns it into a regression gate: exit code 3 when a guarded metric falls.
 */

export const BenchCommand = effectCmd({
  command: "bench",
  describe: "measure build-off quality on this repository's own history (no human review needed)",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("replay", { type: "boolean", default: true, describe: "replay merged fixes with their tests hidden" })
      .option("dir", { type: "string", describe: "repository (default: current directory)" })
      .option("limit", { type: "number", default: 10, describe: "how many tasks to replay" })
      .option("scan", { type: "number", default: 300, describe: "how many commits to search for tasks" })
      .option("builders", { type: "number", default: 3 })
      .option("reviewers", { type: "number", default: 2 })
      .option("model", { type: "string", array: true, describe: "builder to include, as provider/model (repeatable)" })
      .option("provider", { type: "string", array: true, describe: "only use models from these providers" })
      .option("budget", { type: "number", default: 3, describe: "spending cap in USD per task" })
      .option("minutes", { type: "number", default: 15, describe: "build time limit per task" })
      .option("perturb", {
        type: "boolean",
        default: true,
        describe: "check the judge with damaged copies of the human patch",
      })
      .option("baseline", { type: "string", describe: "fail (exit 3) when a metric falls below this saved report" })
      .option("save-baseline", { type: "string", describe: "write this run's metrics as a baseline" })
      .option("attach", { type: "string", describe: "use a running engine" })
      .option("username", { type: "string" })
      .option("password", { type: "string" })
      .option("json", { type: "boolean", default: false }),
  handler: Effect.fn("Cli.bench")(function* (args) {
    const directory = path.resolve(args.dir ?? process.cwd())
    const engine = yield* Effect.promise(() => startEngine(args))
    const report = yield* Effect.promise(async () => {
      try {
        return await runReplay(connect(engine.url, engine.authorization), {
          directory,
          limit: args.limit,
          scan: args.scan,
          builders: args.builders,
          reviewers: args.reviewers,
          prefer: args.model,
          providers: args.provider,
          budgetUsd: args.budget,
          minutes: args.minutes,
          perturb: args.perturb,
          onEvent: (event) => {
            if (!args.json)
              UI.println(
                `${UI.Style.TEXT_DIM}· ${event.sha.slice(0, 9)} ${event.stage}${event.detail ? ` — ${event.detail}` : ""}${UI.Style.TEXT_NORMAL}`,
              )
          },
        })
      } finally {
        await engine.stop()
      }
    })

    if (args["save-baseline"])
      writeFileSync(args["save-baseline"], `${JSON.stringify({ metrics: report.metrics }, null, 2)}\n`)
    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else print(report)

    if (report.metrics.tasks === 0)
      return yield* fail(
        "No replayable task was found: no commit added a test that fails before it and passes after.",
        2,
      )
    if (args.baseline) {
      const baseline = JSON.parse(readFileSync(args.baseline, "utf8")) as { metrics: Partial<ReplayMetrics> }
      const fell = regressions(report.metrics, baseline.metrics)
      if (fell.length) {
        for (const entry of fell)
          UI.error(`${entry.metric} fell from ${entry.baseline} to ${entry.current ?? "nothing"}`)
        return yield* fail("Build-off quality regressed against the baseline.", 3)
      }
    }
  }),
})

function print(report: ReplayReport) {
  const m = report.metrics
  const pct = (value: number | null) => (value === null ? "—" : `${value}%`)
  UI.empty()
  UI.println(`${UI.Style.TEXT_HIGHLIGHT_BOLD}Quality Lab${UI.Style.TEXT_NORMAL}  ${report.repo}`)
  UI.println(`${report.scanned} commits scanned, ${report.mined} with tests, ${m.tasks} replayed`)
  UI.empty()
  UI.println(`resolved (judges' winner)         ${pct(m.resolvedRate)}`)
  UI.println(`resolved (any candidate)          ${pct(m.oracleRate)}`)
  UI.println(`resolved (one attempt, average)   ${pct(m.singleAttemptRate)}`)
  UI.println(`level with or beats human patch   ${pct(m.atLeastHumanRate)}`)
  UI.println(`winner quality percentile (median) ${m.winnerPercentileMedian ?? "—"}`)
  UI.println(`judge: grounded accuracy          ${pct(m.judgeGroundedAccuracy)}`)
  UI.println(`judge: prefers undamaged patch    ${pct(m.judgePerturbationAccuracy)}`)
  UI.println(`judge: ties identical patches     ${pct(m.judgeIdentityRate)}`)
  UI.empty()
  for (const [model, entry] of Object.entries(m.perModel).sort(
    (a, b) => b[1].resolved / b[1].tasks - a[1].resolved / a[1].tasks,
  ))
    UI.println(`  ${model.padEnd(40)} ${entry.resolved}/${entry.tasks}`)
  const skipped = report.tasks.filter((task) => !task.valid)
  if (skipped.length) {
    UI.empty()
    UI.println(`${UI.Style.TEXT_DIM}${skipped.length} task(s) not replayable:${UI.Style.TEXT_NORMAL}`)
    for (const task of skipped.slice(0, 10))
      UI.println(
        `${UI.Style.TEXT_DIM}  ${task.sha.slice(0, 9)} ${task.subject} — ${task.reason}${UI.Style.TEXT_NORMAL}`,
      )
  }
  UI.println(
    `${UI.Style.TEXT_DIM}cost $${m.costUsd.toFixed(4)} · guarded: ${GUARDED.map((entry) => entry.key).join(", ")}${UI.Style.TEXT_NORMAL}`,
  )
}
