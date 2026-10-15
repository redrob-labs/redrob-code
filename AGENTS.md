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

Branch names are `<type>/<slug>` with the type from the redrob-labs organization list:
`feat fix chore docs test refactor perf ci build sync hotfix release` (`docs/BRANCHING.md` has the
ones this repository actually uses: `feat/<slug>`, `sync/upstream-<tag>`, `hotfix/<slug>`,
`release/<version>`). Do not invent a prefix, and in particular do not name a branch after the tool
or agent that made it: a branch name says what the change is, not who typed it.

- **`develop`** integrates. Release from it: the `release` workflow builds, signs, tags, publishes
  the release, and prints a link to open the promotion pull request from `develop` into `main`.
- **`main`** is released state. It moves through a reviewed pull request, not an automated push.
- **Hotfix**: branch from `main`, merge into `main`, release, **then merge `main` back into
  `develop`**. This is the step that gets skipped. #13 fixed the lockfile on `main`, the back-merge
  never happened, and for a month `bun install --frozen-lockfile` failed on the default branch.
  The shared gitflow workflow now opens the back-merge pull request (`sync/back-merge-<sha>`) on
  every push to `main` that leaves `main` ahead of `develop`, so this is checked rather than
  remembered.
- Both branches are protected: pull requests only, force pushes and deletions blocked, zero required
  reviews, admin enforcement off. Required checks: `typecheck`, `unit (linux)`, `core (linux)`,
  `httpapi (linux)`.

Both rules above are enforced by CI, not by memory. `gitflow.yml` is a verbatim copy of the
organization's caller template and only calls `redrob-labs/.github/.github/workflows/gitflow.yml`,
which owns both checks: `gitflow / branch name follows the convention` on every pull request
(because a prefix nobody defined, `kiro/`, reached this repository while the rule sat in prose) and
`gitflow / main is contained in develop` on every push to `main`. Do not add a type list to the
caller; the one list lives in the organization repository. This repository's own tag rule (no
workflow pushes tags in bulk) is `tag-hygiene.yml`.

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
- The version line is ours and starts at `0.1.0`. It does not encode the upstream version, which
  lives in `UPSTREAM_VERSION` at the repository root and is what the release notes read. Do not
  reintroduce a `-redrob.N` suffix: it made every release a semver prerelease, which sorts below
  the release it precedes and made `getReleaseType()` call everything a patch. See
  `docs/VERSIONING.md`.

## Where a change surfaces in the app

The engine stores what the console reports, and the app reads it back. When a field goes missing at
one hop the symptom appears at another, so trace the whole chain rather than the endpoint:

```
console redrobBlock()  ->  protocol RedrobGatewayBlock  ->  getUsage  ->  processor step-finish
                       ->  v1/v2 Assistant  ->  app readMessageUsage
```

A cast that narrows a payload must name every field it carries. One that did not is how streaming
callers silently lost the billed cost while non-streaming callers kept it.
