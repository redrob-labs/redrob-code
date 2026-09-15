# Branching

Redrob Code is a **fork** of [opencode](https://github.com/anomalyco/opencode), and that
single fact decides the branching model. A fork's most consequential operation is not a
feature — it is absorbing upstream, which arrives as a large, conflict-prone merge that
can leave the tree broken for a while. Everything below exists so that merge never lands
somewhere people are cloning from.

## Branches

| Branch | What it is |
|---|---|
| `develop` | **Default.** Integration. Every feature, fix and upstream sync lands here first. |
| `main` | The released state. Only ever advanced by a release pull request from `develop`. |
| `feature/<slug>` | One change, opened as a pull request into `develop`. |
| `sync/upstream-<tag>` | An upstream absorption, opened as a pull request into `develop`. |
| `hotfix/<slug>` | A fix for something already released, into `main` **and** `develop`. |
| `release/<version>` | Only when a release needs stabilising before it ships. Usually skipped. |

`develop` is the default branch on purpose. Pull requests target it without anyone
having to retarget them, and the people reading the repository's default branch are
contributors. End users install a release artifact; they do not clone.

We do not use `master`, and our branches are deliberately **not** named after upstream's
(`dev`, `main`). When you add an `upstream` remote, `upstream/dev` and `origin/develop`
should not read as the same thing, because they are not.

`release/*` is in the table for completeness and is usually a waste of a branch. Reach
for it only when a release genuinely needs to stabilise while `develop` keeps moving.

## Syncing upstream

This is the part gitflow has no opinion about, and the part that matters most here.

We follow upstream **tags**, not its `dev` branch. A tag is a point upstream themselves
decided was coherent; `dev` is whatever was pushed an hour ago.

```sh
# once
git remote add upstream https://github.com/anomalyco/opencode.git

# each sync
git fetch upstream --tags
git switch develop && git pull
git switch -c sync/upstream-v1.18.32
git merge v1.18.32
```

The `upstream-sync` workflow does exactly this and opens the pull request for you; run it
from the Actions tab. When the merge conflicts it says which paths conflicted and stops,
because resolving a fork's conflicts is a judgement call about which side is right, and a
machine that guesses at that produces a tree nobody can review.

Three things to know before your first sync:

**The merge base is real, so most of upstream arrives for free.** Our own history sits
directly on an upstream tag. A three-way merge takes upstream's version of every file we
never touched, and every region of a file our changes do not overlap. You resolve only
genuine disagreements — measured at 40 files on the first sync, against 229 total
conflicts of which the rest were "upstream changed something we deliberately deleted".

**Conflicts cluster on rebranding.** Where upstream edits a line we renamed, the merge
cannot know which side wins. Keep ours, take their surrounding change.

**Some `opencode` strings are load-bearing.** Do not "finish the rebrand" while resolving
a conflict. The legacy `.opencode` config directory is read on purpose so existing
checkouts keep working, and `@gitlab/opencode-gitlab-auth`, `opencode-gitlab-auth` and
`opencode-poe-auth` are real published packages that are not ours to rename. See
[NOTICE.md](../NOTICE.md).

Resolve, push, and open the pull request into `develop`. Never merge upstream straight
into `main`.

## Releasing

Versions track upstream with a `-redrob.N` suffix: `v1.18.31-redrob.1` is our first build
against upstream's `v1.18.31`, and `-redrob.2` is a second build against the same
upstream version. The suffix is not decoration — it guarantees no tag we publish is a
string upstream also publishes, so nobody can mistake our artifact for theirs.

Run the `release` workflow from the Actions tab against `develop`. It builds every
platform, signs and notarizes the macOS binaries, signs the Windows binary, attaches
build provenance, creates the tagged release, and then opens a pull request from
`develop` into `main`.

That last step is a pull request rather than a push on purpose. `main` is what people
believe is released; advancing it deserves the same review as anything else, and it is
the one branch where an unreviewed automated push would be hard to notice.

## Hotfixes

Branch from `main`, not `develop`, so the fix does not drag unreleased work with it.
Open the pull request into `main`, release from there, then merge `main` back into
`develop` so the fix is not lost on the next release.
