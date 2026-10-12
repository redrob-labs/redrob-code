import { randomBytes } from "node:crypto"
import path from "node:path"
import { createInterface } from "node:readline/promises"
import { Effect } from "effect"
import { apply, connect, pick, readTask, runContest, type ContestEvent, type ContestResult } from "@redrob-code/contest"
import { ServerAuth } from "@/server/auth"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

/**
 * `redrob buildoff "<task>"`: the blind build-off, headless.
 *
 * Several builders from different companies attempt the task in their own worktrees; the repository's
 * checks, the builders' reproduction tests run against each other, an automatic quality score and
 * position-swapped pairwise reviews by models from other companies decide a ranking; the result is
 * gated against the repository's own human commits. Candidates are shown as A, B, C. Names come back
 * only after a choice is recorded, and the applied commit always says which model wrote it.
 *
 * The same engine API drives it whether the engine is this process or one reached with --attach, so
 * the desktop app and CI run exactly this.
 */

export const BuildoffCommand = effectCmd({
  command: "buildoff [task..]",
  describe: "run a blind build-off: rival models attempt a task, the best verified result wins",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("task", { type: "string", array: true, describe: "the task, or @file to read it from a file" })
      .option("dir", { type: "string", describe: "repository to work in (default: current directory)" })
      .option("builders", { type: "number", default: 3, describe: "how many rival builders" })
      .option("reviewers", { type: "number", default: 2, describe: "how many reviewers judge each pair" })
      .option("model", { type: "string", array: true, describe: "builder to include, as provider/model (repeatable)" })
      .option("provider", { type: "string", array: true, describe: "only use models from these providers" })
      .option("budget", { type: "number", default: 5, describe: "spending cap in USD for the whole build-off" })
      .option("minutes", { type: "number", default: 20, describe: "time limit for building" })
      .option("gate", {
        type: "number",
        default: 90,
        describe: "percentile of this repo's human commits the winner must reach",
      })
      .option("escalate", {
        type: "boolean",
        default: true,
        describe: "add a builder when the best result misses the gate",
      })
      .option("pick", { type: "string", describe: "choose this slot instead of being asked" })
      .option("auto", { type: "boolean", default: false, describe: "accept the judges' winner without asking" })
      .option("apply", {
        type: "string",
        choices: ["branch", "commit", "none"],
        default: "branch",
        describe: "how to apply the chosen candidate",
      })
      .option("attach", { type: "string", describe: "use a running engine (e.g. http://127.0.0.1:4096)" })
      .option("username", { type: "string", describe: "basic auth username for --attach" })
      .option("password", { type: "string", describe: "basic auth password for --attach" })
      .option("json", { type: "boolean", default: false, describe: "print the result as JSON" }),
  handler: Effect.fn("Cli.buildoff")(function* (args) {
    const task = readTask((args.task ?? []).join(" ").trim())
    if (!task) return yield* fail('Give the task: redrob buildoff "Add input validation to the signup form"')
    const directory = path.resolve(args.dir ?? process.cwd())

    const engine = yield* Effect.promise(() => startEngine(args))
    const exit = yield* Effect.promise(async () => {
      try {
        return await buildoff({ ...args, task, directory }, engine.url, engine.authorization)
      } finally {
        await engine.stop()
      }
    })
    if (exit !== 0) return yield* fail("The build-off did not produce a usable candidate.", exit)
  }),
})

type Args = {
  task: string
  directory: string
  builders: number
  reviewers: number
  model?: string[]
  provider?: string[]
  budget: number
  minutes: number
  gate: number
  escalate: boolean
  pick?: string
  auto: boolean
  apply: string
  json: boolean
}

export async function startEngine(args: { attach?: string; username?: string; password?: string }) {
  if (args.attach) {
    return {
      url: args.attach,
      authorization: ServerAuth.header({ username: args.username, password: args.password }),
      stop: async () => {},
    }
  }
  // An engine in this process, on loopback, behind a credential nobody else knows. The server reads
  // its auth from the environment each time it starts (server.ts installs a fresh ConfigProvider).
  const password = process.env["REDROB_SERVER_PASSWORD"] || randomBytes(18).toString("base64url")
  process.env["REDROB_SERVER_PASSWORD"] = password
  const { Server } = await import("../../server/server")
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0, cors: [] })
  return {
    url: server.url.toString().replace(/\/+$/, ""),
    authorization: ServerAuth.header({ password }),
    stop: () => server.stop(true),
  }
}

async function buildoff(args: Args, url: string, authorization: string | undefined) {
  const quiet = args.json
  const say = (line: string) => {
    if (!quiet) UI.println(line)
  }
  const onEvent = (event: ContestEvent) => {
    if (event.type === "stage")
      say(`${UI.Style.TEXT_DIM}· ${event.stage}${event.detail ? ` — ${event.detail}` : ""}${UI.Style.TEXT_NORMAL}`)
    if (event.type === "candidate" && event.status !== "building")
      say(`${UI.Style.TEXT_DIM}  ${event.slot}: ${event.status}${UI.Style.TEXT_NORMAL}`)
    if (event.type === "note") say(`${UI.Style.TEXT_WARNING}! ${event.message}${UI.Style.TEXT_NORMAL}`)
  }

  const result = await runContest(connect(url, authorization), {
    directory: args.directory,
    task: args.task,
    builders: args.builders,
    reviewers: args.reviewers,
    prefer: args.model,
    providers: args.provider,
    budgetUsd: args.budget,
    minutes: args.minutes,
    gatePercentile: args.gate,
    escalate: args.escalate,
    onEvent,
  })

  if (!quiet) report(result)
  if (!result.winner && !args.pick) {
    if (quiet) process.stdout.write(`${JSON.stringify({ result }, null, 2)}\n`)
    return 1
  }

  const slot = (args.pick ?? (args.auto || !process.stdin.isTTY ? result.winner : await ask(result)))!.toUpperCase()
  const reveal = await pick(args.directory, result.id, slot)
  const applied =
    args.apply === "none" ? null : await apply(args.directory, result.id, args.apply === "commit" ? "commit" : "branch")

  if (quiet) {
    // Machine output goes to stdout; the progress lines and table go to stderr like every other command.
    process.stdout.write(`${JSON.stringify({ result, chosen: slot, reveal, applied }, null, 2)}\n`)
    return 0
  }
  UI.empty()
  UI.println(`${UI.Style.TEXT_HIGHLIGHT_BOLD}Revealed${UI.Style.TEXT_NORMAL}`)
  for (const entry of reveal) {
    const mark = entry.slot === slot ? "→" : " "
    UI.println(
      `${mark} ${entry.slot}  ${entry.model.padEnd(36)} quality ${String(entry.quality).padStart(5)}  $${entry.costUsd.toFixed(4)}`,
    )
  }
  if (applied?.branch && applied.strategy === "branch")
    UI.println(`\nApplied as branch ${applied.branch} (${applied.commit.slice(0, 9)}).`)
  else if (applied) UI.println(`\nCommitted ${applied.commit.slice(0, 9)} on ${applied.branch ?? "HEAD"}.`)
  return 0
}

function report(result: ContestResult) {
  UI.empty()
  const status =
    result.status === "passed"
      ? `${UI.Style.TEXT_SUCCESS_BOLD}meets your standard${UI.Style.TEXT_NORMAL}`
      : result.status === "below_standard"
        ? `${UI.Style.TEXT_WARNING_BOLD}below your standard${UI.Style.TEXT_NORMAL}`
        : `${UI.Style.TEXT_DANGER_BOLD}no usable candidate${UI.Style.TEXT_NORMAL}`
  UI.println(
    `Build-off ${result.id}: ${status}${result.neutral ? "" : " (builders were not all from different companies)"}`,
  )
  UI.empty()
  UI.println("    checks   rival tests   quality   pct   points   notes")
  for (const slot of [
    ...result.ranking,
    ...result.candidates.map((c) => c.slot).filter((s) => !result.ranking.includes(s)),
  ]) {
    const c = result.candidates.find((candidate) => candidate.slot === slot)!
    const checks = c.checks.length ? `${c.checks.filter((check) => check.passed).length}/${c.checks.length}` : "—"
    const cross = c.crossTests ? `${c.crossTests.passed}/${c.crossTests.total}` : "—"
    const pct = c.percentile === null ? "—" : String(Math.round(c.percentile))
    const notes =
      c.disqualified ?? (c.flags.length ? `${c.flags.length} test flag(s)` : c.status === "done" ? "" : c.status)
    const mark = slot === result.winner ? "★" : " "
    UI.println(
      `${mark} ${slot}  ${checks.padEnd(8)} ${cross.padEnd(13)} ${String(c.quality.score).padEnd(9)} ${pct.padEnd(5)} ${String(c.points).padEnd(8)} ${notes}`,
    )
  }
  UI.empty()
  for (const gate of result.gates) UI.println(`${gate.passed ? "✓" : "✗"} ${gate.name}: ${gate.detail}`)
  UI.println(
    `${UI.Style.TEXT_DIM}cost $${result.costUsd.toFixed(4)} · ${result.rounds} round(s)${UI.Style.TEXT_NORMAL}`,
  )
}

async function ask(result: ContestResult) {
  const choices = result.candidates.filter((candidate) => candidate.changed).map((candidate) => candidate.slot)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    while (true) {
      const answer = (
        await rl.question(`\nPick ${choices.join("/")} (Enter for the judges' choice, ${result.winner}): `)
      )
        .trim()
        .toUpperCase()
      if (!answer && result.winner) return result.winner
      if (choices.includes(answer)) return answer
    }
  } finally {
    rl.close()
  }
}
