# Versioning

Redrob Code has its own version line starting at `0.1.0`, following semver.

## Why there is no suffix

Before `0.1.0` versions carried a `-redrob.N` suffix, for example `1.18.31-redrob.10`.
That shape cost three things.

1. `1.18.31-redrob.10` is a semver PRERELEASE. Prereleases sort below the release they
   precede, so every comparison against a plain version was wrong in a way that looked
   right, and `getReleaseType()` classified every single release as a patch because it
   only reads major and minor.
2. The numbers did not say anything about our own release history.
3. Shipping a fix meant deciding what base number to claim it was against.

## Bumping

`release.yml` takes a `bump` input of `patch`, `minor` or `major` and computes the next
version from the newest `v*` tag. There is no version string to edit in the repository:
`packages/redrob/package.json` stays at `0.0.0` and the build receives the real version
through `REDROB_VERSION`.
