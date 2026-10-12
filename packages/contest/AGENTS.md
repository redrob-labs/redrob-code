# packages/contest

The blind build-off behind `redrob buildoff` and, later, the desktop build-off screen. Design of record:
`docs/CONTEST.md`.

- **Public engine API only.** `src/engine.ts` drives sessions, messages, permissions and models through
  `@redrob-code/client`. Do not import engine internals: the contest must keep working across upstream
  syncs and against an engine reached with `--attach`.
- **Blindness is a contract.** `ContestResult` names slots and `R1`/`R2`, never a model, provider or
  vendor. The mapping is written only to `.git/redrob/contests/<id>.json`, and `pick` is the only
  reader. It records the preference first, then reveals. The integration test fails if a model key
  appears in the result.
- **Verification is automatic.** Anything that decides a ranking or a gate must be either measured
  (checks, cross-tests, diff statistics) or a position-consistent pairwise vote. Never let a single
  model's pointwise score decide.
- **Never touch the person's checkout** except in `apply` with `--apply commit`. Worktrees live under
  `worktreeRoot()`, are detached, and are removed at the end. Candidates survive as
  `refs/redrob/contest/<id>/<slot>`.
- `messages.list` serves at most 200 per page. Page with the cursor (`allMessages`).
- A run is finished only when the session is idle **and** its newest message is a completed assistant
  reply, on two readings in a row. Idle alone is true before a prompt's first turn starts.

Verify with `bun run typecheck` and `bun test`. The integration tests need the engine binary
(`bun run --cwd packages/redrob build --single --skip-install`, or `REDROB_CODE_ENGINE=<path>`) and skip
without it.
