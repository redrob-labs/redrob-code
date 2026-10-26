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
| `feat/<slug>` | One change, opened as a pull request into `develop`. Also `fix/`, `docs/`, `chore/` and the rest of the organization type list, when they describe the change better. |
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

The full type list is the redrob-labs organization's, checked by the shared gitflow workflow on
every pull request: `feat fix chore docs test refactor perf ci build sync hotfix release`. The
caller in `.github/workflows/gitflow.yml` is a verbatim copy of the organization template and
carries no list of its own.

## Upstream

Redrob Code no longer merges upstream (opencode) releases; that stopped on 2026-10-26.
Upstream files are ours to change like any other. `UPSTREAM_VERSION` still records the
upstream release this tree was last merged from, because attribution needs it and the
release notes state it.

Some `opencode` strings are still load-bearing and stay as they are. The legacy
`.opencode` config directory is read on purpose so existing checkouts keep working, and
`@gitlab/opencode-gitlab-auth`, `opencode-gitlab-auth` and `opencode-poe-auth` are real
published packages that are not ours to rename. See [NOTICE.md](../NOTICE.md).

## Releasing

Versions are ours and start at `0.1.0`. They are not derived from the upstream version the
tree is built on: that is recorded in `UPSTREAM_VERSION` at the repository root, and the
release notes read it so every release still states what it is based on. The old
`-redrob.N` suffix was retired because it made every release a semver prerelease, which
sorts below the release it precedes. See `docs/VERSIONING.md`.

Run the `release` workflow from the Actions tab against `develop` with a `bump` of `patch`,
`minor` or `major`. It computes the next version from the newest `v*` tag, builds every
platform, signs and notarizes the macOS binaries, signs the Windows binaries and installer
through Azure Artifact Signing, attaches build provenance, pushes the annotated tag, and
publishes the release. It then prints a link to open the promotion pull request from
`develop` into `main`.

`main` moves through a reviewed pull request rather than an automated push. It is what
people believe is released, and it is the one branch where an unreviewed push would be
hard to notice.

Pass `dry_run: true` to build, sign and notarize while tagging and publishing nothing. That
is the way to check the signing credentials are actually visible to this repository --
organization secrets are not automatically visible to a new public repository.

The last two jobs are the organization's, not this repository's. Windows signing is the
shared composite action `redrob-labs/.github/actions/sign-windows`, and the release is the
shared reusable workflow `redrob-labs/.github/.github/workflows/release-publish.yml`, which
collects every `release-*` artifact, writes `SHA256SUMS.txt` and `redrob-launcher.json`,
and publishes `v<version>` as latest (as a prerelease when the version carries a `-`). This
workflow passes it the tag and the commit explicitly, because the tag is created by the
`tag` job here rather than by a push. The release notes are GitHub's generated notes; the
upstream version the build is based on is in the tag message and in `UPSTREAM_VERSION`.
What stays this repository's: version resolution, the Bun build, macOS notarization, the
Linux archives, the Redrob Launcher asset copies (`launcher-assets.ts`), the `VERSION`
marker `install.sh` reads, and build provenance.

Windows signing is Azure Artifact Signing authenticated with the job's OpenID Connect
token: the `sign-windows` job runs in the `release` environment with `id-token: write`,
and `azure/login` exchanges the token for an Azure credential right before the shared
action runs signtool with the Artifact Signing dlib. The login comes after the build and
immediately before each signing step because the OIDC token lives minutes. The inputs are
the redrob-labs organization secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID` (plain IDs for the login) and `ARTIFACT_SIGNING_ENDPOINT`,
`ARTIFACT_SIGNING_ACCOUNT`, `ARTIFACT_SIGNING_CERT_PROFILE` (the account to sign with); no
certificate file and no client secret exist anywhere. The three `ARTIFACT_SIGNING_*` names
alone decide whether signing happens -- all unset means an unsigned build with a warning,
some set is an error. Every signed file is read back with `signtool verify /pa` and must be
`Valid` with the signer `CN=McKinley Rice, Inc.`; the log prints `<file> signed by CN=...`.
A failed signature fails the job and so the release.

## Hotfixes

Branch from `main`, not `develop`, so the fix does not drag unreleased work with it.
Open the pull request into `main`, release from there, then merge `main` back into
`develop` so the fix is not lost on the next release.

That last step is checked, because it is the one that gets skipped. The shared gitflow
workflow (`gitflow / main is contained in develop`) runs on every push to `main` and, while
`main` holds a commit `develop` does not, opens the back-merge pull request itself as
`sync/back-merge-<sha>`. A promotion pull request from `develop` leaves the two identical
and the check says nothing; a hotfix opens the back-merge until it is brought back.

The invariant it enforces, which you can read yourself at any time:

```bash
git rev-list --count origin/develop..origin/main   # 0, outside a release window
```

It was not 0 for a month. #13 fixed `bun install --frozen-lockfile` on `main`, the
back-merge never happened, and the default branch could not install with the bun version
`packageManager` pins. The rule above was already written; nothing checked it, and a rule
nothing checks is a preference.
