# Notice

Redrob Code is a fork of [opencode](https://github.com/anomalyco/opencode),
copyright (c) 2025 opencode, distributed under the MIT License. The full upstream
licence text is retained in [LICENSE](./LICENSE), alongside Redrob Labs' copyright in
the modifications.

This repository is a modified derivative. It is not affiliated with, endorsed by, or
supported by the opencode project or its maintainers. "opencode" is used here only to
describe the origin of this software.

MIT grants no rights in a project's name. Where this codebase still reads `opencode`,
it is either a compatibility identifier that would break users' existing checkouts if
renamed — the legacy `.opencode` config directory, read alongside `.redrob` — or a
genuinely third-party published package: `@gitlab/opencode-gitlab-auth`,
`opencode-gitlab-auth`, and `opencode-poe-auth` are upstream-ecosystem packages
resolved from npm, not ours to rename.

Releases track upstream's version numbers with a `-redrob.N` suffix rather than
matching them exactly, so no tag string we publish collides with one upstream
publishes. `v1.18.31-redrob.1` is the first Redrob Code build against opencode
`v1.18.31`.

## Third-party material

- `packages/docs/` was seeded from the Mintlify docs starter template, MIT,
  copyright (c) 2023 Mintlify. See [packages/docs/LICENSE](./packages/docs/LICENSE).
- `packages/http-recorder/` carries its own copy of the upstream MIT licence at
  [packages/http-recorder/LICENSE](./packages/http-recorder/LICENSE).

Dependency licences are not enumerated here. Every in-tree package declares MIT and
an audit of in-tree source found no copyleft-licensed material, but the licences of
the dependency graph resolved from `bun.lock` are a separate question from this
repository's own contents.
