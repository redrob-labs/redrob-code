# The blind build-off

Design of record for `packages/contest` (`@redrob-code/contest`) and the `redrob buildoff` command.

```sh
redrob buildoff "Add input validation to the signup form"
redrob buildoff @task.md --builders 4 --budget 8 --auto --apply commit
```

## What happens

1. **Bench.** The contest picks one model from each of N companies, taken from what the engine serves
   (`GET /api/model`). Two reviewers come from companies that are _not_ building, where possible.
   - Never picked: routers (`auto`), models that require data sharing (`claude-fable-*`), and
     non-chat models.
   - Slots are shuffled, so `A` says nothing about the model.
   - With too few companies, it fills the slots anyway and the result says `neutral: false`.
2. **Baseline.** A worktree at `HEAD` runs the repository's own setup and checks first. Checks are found
   from `package.json` scripts, `pyproject.toml`, `Cargo.toml` or `go.mod`, and
   `.redrob/contest.json` overrides them. A check that already fails on the base commit is never
   blamed on a builder.
3. **Build.** Each builder works in its own detached worktree at the same base, in parallel, through an
   ordinary engine session.
   - It is asked for the smallest complete change, plus a new reproduction test that fails without the
     change.
   - It must not touch existing tests and must not name itself.
   - Each builder has a share of the budget and a deadline. Permissions inside its worktree are
     answered "once"; anything that reaches outside is refused.
4. **Verify, with no model involved.**
   - The repository's checks run on each candidate and are compared with the baseline.
   - **Cross-tests:** every candidate runs every other builder's reproduction tests. A rival's test
     counts only if it fails on the base commit, because a test that already passes there proves
     nothing.
   - **Quality Score** (0–100): penalties for added debug output, TODOs and lint suppressions;
     repeated blocks; deep nesting; long lines; oversized changes; untested code; regressed checks;
     and new warnings. The weights are stated in `src/quality.ts`.
   - **Percentile:** the same diff measurement runs on the repository's recent human commits, which
     places each candidate in the repo's own distribution.
   - **Test-gaming guard:** flags edited, deleted, skipped or focused tests; changed test
     configuration; rewritten snapshots; and code that branches on running under test.
5. **Tournament.**
   - Every pair of candidates goes to each reviewer whose company built neither side, in **both
     orders**. A reviewer's vote counts only if it picks the same candidate both times.
   - Reviewers see de-identified diffs, labelled "first" and "second", together with all the
     evidence above. They run under the read-only `plan` agent.
   - Ranking is by pairs won, then by Quality Score.
6. **Gates.** The judges' winner must clear three gates:
   - **correctness:** no check regressed, and it passes a majority of the rival reproduction tests;
   - **quality:** at or above the repo's p90 human commit (`--gate`, rising to 99), or a score of 80
     when the repo has fewer than five usable commits;
   - **consensus:** it won at least half its pairs outright.

   A flagged candidate can win only if every reviewer accepted its test changes.

7. **Escalate.** If the gates fail and budget remains, one more builder from an unused company is
   added and everything is judged again. Otherwise the result is `below_standard`, and it is shown as
   such, never as passing.
8. **Pick, reveal, apply.**
   - The choice (or `--auto`, the judges' winner) is appended to `.git/redrob/preferences.jsonl`
     _before_ names are revealed.
   - `apply` creates `redrob/contest-<id>` (or cherry-picks with `--apply commit`). The commit carries
     these trailers:

     ```
     Redrob-Model: <model>
     Redrob-Provider: <provider>
     Redrob-Contest: <id>
     ```

   - Every candidate stays reachable at `refs/redrob/contest/<id>/<slot>`, and worktrees are removed.

## Blindness

- The result handed to any caller names slots (`A`, `B`, `C`) and reviewers (`R1`, `R2`) only. Which
  model built or reviewed what lives in `.git/redrob/contests/<id>.json`, and only `pick` returns it.
- Text a reviewer or chooser sees passes through `redact`. Builder summaries are redacted as well.
- Style can still give a model away. The product says "names hidden", never "undetectable".

## Where it runs

The contest drives the engine only through its public HTTP API (sessions, messages, permissions,
models), the same surface Redrob Cowork and the desktop app use. `redrob buildoff` starts an engine in
process on loopback behind a random credential, or uses `--attach <url>`. The desktop app calls the
same library from its main process (`apps/desktop/src/main/buildoff.ts`) against the engine it already
runs, so the build-off screen needed no new engine routes. A `/contest` HTTP surface stays deferred
until something other than the app and the CLI (Redrob Cowork, a remote runtime) has to start one.

What the app adds on top of the library:

- **Cancel.** `runContest` takes an `AbortSignal`; aborting stops every builder and reviewer session and
  records the contest as `cancelled`.
- **Preview.** `startPreview` checks a candidate's ref out into a scratch worktree and runs the repo's
  own dev script there, so a person can try a candidate before choosing it. Names stay hidden.
- **Diff and history.** `candidateDiff` returns a candidate's blinded diff against base; `history` lists
  earlier contests from `.git/redrob/contests/`.
- **Only usable models compete.** Models from an integration that is not connected, or a provider the
  person disabled, are dropped before slots are assigned, so a missing key cannot take a builder slot.
  With fewer than two contenders left the consensus gate fails rather than passing a one-model "build-off".

## Tests

- `test/units.test.ts` covers every pure module.
- `test/contest.integration.test.ts` runs two whole build-offs, once through the library and once
  through the compiled `redrob buildoff`.
  - Both run against the real engine binary, with `test/fixture/fake-llm.ts` serving five scripted
    vendors.
  - The scenario has three builders (correct; correct but messy; wrong) and two position-consistent
    reviewers. It asserts the ranking, every gate, cross-tests, blindness, the preference record, the
    reveal and the applied commit's trailers.

## Not yet

| Item                                                                                                                                                     | Milestone            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Mutation score of the winner's tests                                                                                                                     | M4, with refinement  |
| Tie-breaker tests written where candidates disagree; polish rounds; weights calibrated on the repo's defect history; standard mined from review comments | M4                   |
| `/contest` HTTP surface on the engine                                                                                                                    | When Cowork needs it |

## The Quality Lab (`redrob bench --replay`)

The Lab uses the repository's own history as the benchmark. No human reviews anything.

1. **Mine.** Find merged commits that changed code _and_ tests, skipping docs-only changes and commits
   the contest wrote itself (`Redrob-Model:`). The commit message, minus trailers, is the task.
2. **Snapshot without history.** Each task's parent tree is extracted into a fresh one-commit
   repository (`git archive`), so a builder cannot read the answer from `git log`.
3. **Validate.** The commit's tests must fail on the parent and pass with the human patch. Anything
   else is reported as not replayable, with the reason.
4. **Build-off** on the snapshot. Percentiles use the real repository's history before the parent.
5. **Hidden tests.** The commit's tests are restored over every candidate and run, and each candidate
   is marked resolved or not.
6. **Head to head.** The resolved winner is reviewed against the human patch, blind, in both orders,
   by reviewers outside the winner's company.
7. **Judge checks, with no labels.**
   - **Grounded accuracy:** wherever exactly one side of a judged pair passes the hidden tests, did
     the tournament pick it?
   - **Perturbations:** the human patch is damaged in one way at a time (`src/perturb.ts`: a flipped
     operator, a duplicated block, debris, a skipped test). The judge must prefer the original in
     both orders.
   - **Identity:** the judge must call an identical pair a tie.

| Metric                                                                    | Meaning                                                     |
| ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `resolvedRate`                                                            | Judges' winner passes the hidden tests                      |
| `oracleRate`                                                              | Any candidate does (the ceiling of a perfect judge)         |
| `singleAttemptRate`                                                       | One attempt, on average (what best-of-N is beating)         |
| `atLeastHumanRate`                                                        | Resolved winners judged level with or above the human patch |
| `winnerPercentileMedian`                                                  | Winner's Quality Score against the repo's human commits     |
| `judgeGroundedAccuracy`, `judgePerturbationAccuracy`, `judgeIdentityRate` | Whether to trust the judge                                  |

Reports are kept in `.git/redrob/bench/`. `--save-baseline` writes the metrics; `--baseline` exits 3
when a guarded metric falls beyond its tolerance (`GUARDED` in `src/replay.ts`). The `bench` workflow
runs this with real models weekly and on pull requests that change `packages/contest/src`, whenever
`REDROB_BENCH_API_KEY` is configured.

**Limits, stated honestly:**

- Only changes that came with tests can be replayed.
- Public repositories may be in models' training data.
- The judge checks are automatic proxies for human agreement, not a human panel.
