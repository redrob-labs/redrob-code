# Contributing

Thanks for helping. This is the working agreement for the repository: how branches are named, what
has to be green before a merge, and the rules that exist because this is a **fork** of
[opencode](https://github.com/anomalyco/opencode) rather than a standalone project.

## Branch model

Git Flow. Two long-lived branches:

| Branch    | What it is                                                          |
| --------- | ------------------------------------------------------------------- |
| `develop` | The default branch, and the next release. Everything merges here first. |
| `main`    | What was released. Only release and hotfix branches merge here.      |

Short-lived branches carry a prefix so intent is readable in a branch list:

| Prefix      | Cut from  | Merges into              | For                                     |
| ----------- | --------- | ------------------------ | --------------------------------------- |
| `feature/*` | `develop` | `develop`                | New work                                |
| `fix/*`     | `develop` | `develop`                | Bugs that can wait for the next release |
| `release/*` | `develop` | `main` **and** `develop` | Preparing a release                     |
| `hotfix/*`  | `main`    | `main` **and** `develop` | Something broken in a shipped build     |

The rule that matters: **nothing lands on `main` without also landing on `develop`.** A hotfix that
only reaches `main` is silently undone by the next release.

Note that `develop` is the default here and in
[redrob-console](https://github.com/mckinley-and-rice/redrob-console). The other Redrob
repositories run a single `main` trunk, so check the branch you are cutting from rather than
assuming.

## The fork rules

Both are checked by CI, not by convention.

1. **Do not remove the upstream copyright notice.** The MIT licence requires it to be retained in
   every copy. Add your name; do not take theirs out.
2. **Branding and locale changes are GENERATED, not hand-edited.** The sweep scripts reproduce them
   from upstream, and a hand edit is lost the next time upstream is absorbed. See
   [docs](./docs) for how an upstream release is taken.

Upstream syncs land through `.github/workflows/upstream-sync.yml` and are reviewed like anything
else.

## Day to day

The package manager version is pinned in `package.json` and CI installs with it, so use the pinned
Bun rather than whatever is on your path.

```bash
git switch develop && git pull
git switch -c feature/short-description

bun install
bun run typecheck
bun run lint
bun test

# open a pull request into develop
```

Keep a pull request to one coherent change. Several unrelated fixes in one branch are harder to
review and impossible to revert independently.

### Commits

Write the subject in the imperative, "Add the credit ledger" rather than "Added" or "Adding", and
use the body to say _why_. If a decision has a non-obvious reason, or you ruled out an approach a
reviewer would ask about, that belongs in the commit message, where it outlives a PR comment.

One commit per logical change. If a branch does three separable things, make it three commits.

## What CI checks

- **typecheck** (`.github/workflows/typecheck.yml`) across every package.
- **test** (`.github/workflows/test.yml`), sharded, on Linux and Windows. The Windows shards are
  slower and shard composition shifts when test files are added, so a failure that follows the shard
  rather than your diff is worth checking against the same job on `develop` before assuming it is
  yours.

Run `bun test` before pushing.

## Cutting a release

Releases track upstream with a `-redrob.N` suffix, so no tag published here is a string upstream also
publishes: `v1.18.31-redrob.2` is our second build against upstream's `v1.18.31`.

The release workflow is `workflow_dispatch` only, because it reaches real signing credentials and
must not be reachable from a pull request or a comment. It builds, signs, publishes, and then opens a
pull request from `develop` into `main` rather than pushing there itself.
