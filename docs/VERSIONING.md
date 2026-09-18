# Versioning

Redrob Code has its own version line starting at `0.1.0`. It is not derived from the
upstream version it is built on.

## Why the version is ours

Until `0.1.0` the version was the upstream version with a suffix: `1.18.31-redrob.10`
tracked opencode `v1.18.31`, tenth build. That shape encoded useful provenance in the tag
and cost three things to get it.

1. `1.18.31-redrob.10` is a semver PRERELEASE. Prereleases sort below the release they
   precede, so every comparison against a plain version was wrong in a way that looked
   right, and `getReleaseType()` classified every single release as a patch because it
   only reads major and minor.
2. It made our release numbers look like upstream's. Someone reading `1.18.31` had no
   reason to know whose 1.18.31 it was.
3. It tied our release cadence to upstream's. Shipping a fix meant deciding what upstream
   version to claim it was against.

## Where the provenance went

`UPSTREAM_VERSION` at the repository root. One line, the upstream version this tree is
merged up to, without the `v`. `upstream-sync.yml` updates it when it absorbs an upstream
release, and the release notes read it so every release still states what it is built on.

That file is the only place the upstream version lives now. Deleting it does not break a
build; it silently removes the answer to "what is this built on", which is worse.

## Bumping

`release.yml` takes a `bump` input of `patch`, `minor` or `major` and computes the next
version from the newest `v*` tag. There is no version string to edit in the repository:
`packages/redrob/package.json` stays at `0.0.0` and the build receives the real version
through `REDROB_VERSION`.
