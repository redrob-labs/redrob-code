# AGENTS.md

Redrob Code: the engine behind Redrob Cowork, a fork of OpenCode. It is consumed as a pinned
version rather than a branch — `constants.json` in `redrob-cowork` names the release the desktop app
ships, so **a change here reaches users only through a release and a pin bump**, never by merging.

Per-package instructions live beside the code they describe and are more specific than this file.
There are ten of them; list them with `git ls-files | grep 'AGENTS.md$'`. **Read the nearest one
before editing a package** — `packages/redrob/`, `packages/redrob/test/`, `packages/schema/`,
`packages/llm/` and `packages/codemode/` each have their own, and three sit deeper under
`packages/redrob/src/**`.

## Branches

Gitflow. **`develop` is the default branch and the base of every pull request.**

Branch names come from `docs/BRANCHING.md` and nothing else: `feature/<slug>`,
`sync/upstream-<tag>`, `hotfix/<slug>`, `release/<version>`. Do not invent a prefix, and in
particular do not name a branch after the tool or agent that made it: a branch name says what the
change is, not who typed it.

The table has no name for the back-merge that closes a hotfix, which is part of why that step gets
skipped. Until it does, use `hotfix/<slug>-backmerge` and say in the pull request that it carries
`main` into `develop`.

- **`develop`** integrates. Release from it: the `release` workflow builds, signs, tags, and then
  prints a link to open the promotion pull request from `develop` into `main`.
- **`main`** is released state. It moves through a reviewed pull request, not an automated push.
- **Hotfix**: branch from `main`, merge into `main`, release, **then merge `main` back into
  `develop`**. This is the step that gets skipped. #13 fixed the lockfile on `main`, the back-merge
  never happened, and for a month `bun install --frozen-lockfile` failed on the default branch.
  A `branch-sync.yml` that fails on push to `main` while `main` holds a commit `develop` does not is
  **proposed in #26 and not merged**, so nothing checks this today. As of writing, `main` is four
  commits ahead and the lockfile fix is still missing from `develop`.
- Both branches are protected: pull requests only, force pushes and deletions blocked, zero required
  reviews, admin enforcement off. Required checks: `typecheck`, `unit (linux)`, `core (linux)`,
  `httpapi (linux)`.

The invariant, readable by hand:

```bash
git rev-list --count origin/develop..origin/main   # 0, outside a release window
```

Full detail in `docs/BRANCHING.md`.

## Verification

- **Use the pinned bun.** `packageManager` names it, and the version matters more than it looks:
  bun 1.3.14 fails a stale lockfile with `lockfile had changes, but lockfile is frozen`, while 1.4.2
  prints `note: skipped 1 workspace listed in bun.lock but not on disk` and continues. A defect that
  only the pinned version reports is invisible to anyone running a newer one.
- `bun install --frozen-lockfile` is a real gate, not a formality. Delete a workspace and the
  lockfile must be regenerated in the same change.
- The `pre-push` hook runs `bun typecheck` and asserts the bun version satisfies `^`packageManager``.
  Do not bypass it with `--no-verify`; if it cannot run, put bun and `node_modules/.bin` on PATH
  instead.
- Judge by the exit code, not by a pass count. A suite can print `0 fail` and still exit non-zero
  when a file fails to load: its tests are never counted and a `(fail)` grep finds nothing.
- A version suffix is load-bearing. `v1.18.31-redrob.9` is our ninth build against upstream's
  `v1.18.31`; the suffix guarantees no tag we publish is a string upstream also publishes.

## Where a change surfaces in the app

The engine stores what the console reports, and the app reads it back. When a field goes missing at
one hop the symptom appears at another, so trace the whole chain rather than the endpoint:

```
console redrobBlock()  ->  protocol RedrobGatewayBlock  ->  getUsage  ->  processor step-finish
                       ->  v1/v2 Assistant  ->  app readMessageUsage
```

A cast that narrows a payload must name every field it carries. One that did not is how streaming
callers silently lost the billed cost while non-streaming callers kept it.
