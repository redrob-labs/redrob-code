# Redrob Code Desktop

Design of record for the desktop app in `apps/desktop` (Electron main + preload) and `apps/studio`
(React interface). The CLI is unchanged and remains a complete product on its own.

## Two products, one release

|                | CLI (unchanged)                                                                                          | Desktop                                     |
| -------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Install        | `curl -fsSL https://console.redrob.ai/code/install.sh \| sh`, `install.ps1`, `redrob-code-x64-setup.exe` | `redrob-code-desktop-<version>-win-x64.exe` |
| Release assets | `redrob-<os>-<arch>.{zip,tar.gz}`, `redrob-code-x64-setup.exe`, `SHA256SUMS`, `VERSION`                  | `redrob-code-desktop-*`, `latest.yml`       |
| Updates        | `redrob upgrade`                                                                                         | electron-updater, stable and alpha channels |

- The CLI assets are published first. `release.yml`'s `desktop-windows` job runs after `publish` and
  only adds files, so a desktop failure never holds back the CLI.
- No desktop file name can match what `install` downloads (`APP=redrob`, `redrob-$target$ext`).
  `apps/desktop/test/misc.test.ts` pins this.
- The `desktop` workflow runs the vanilla `install` script against every pull request's build.

## How the app runs the engine

```
Electron main ── spawn ──> redrob serve --hostname 127.0.0.1 --port 0     (random Basic credential)
     │  waits for "redrob server listening on <url>"  (serve.ts, pinned by test/listening.test.ts)
     ▼
oc://renderer/ (apps/studio) ── HTTP + SSE + WebSocket ──> engine  (@redrob-code/client)
```

- **The engine is bundled** as `resources/engine/redrob` (`redrob.bin` on Windows), copied from the
  release's own signed CLI binary, so the app and the CLI run byte-identical engines.
- **Resolution order:** `REDROB_CODE_BIN`, then an installed CLI if the person chose "use the installed
  CLI", then the bundled engine, then an installed CLI.
- **The bundled engine never updates itself** (`REDROB_DISABLE_AUTOUPDATE=1`); the app's updater
  replaces it. A separately installed CLI keeps `redrob upgrade`.
- **The app never writes to PATH or to a CLI install directory.** Settings → "Install the redrob command"
  runs the official installer, which produces an ordinary, self-updating CLI install.
- **The interface is served from `oc://renderer`**, which the engine's CORS allowlist already accepts
  (`packages/server/src/cors.ts`). `file://` would send `Origin: null` and be refused.
- **The engine's data directory is shared with the CLI**, so sign-in, sessions and history appear in
  both.

## Sign-in

The Console device flow (`/v1/device/authorize`, `/v1/device/token`, product `code`) runs in the main
process. The returned key goes straight to the engine (`POST /api/integration/redrob/connect/key`). It
never reaches the interface and is never stored by the app. Signing in is offered, not required: the
engine also works with a person's own provider keys.

## Privacy

On first run there are two switches, both off: crash reports and usage events. Nothing is collected in
this milestone either way. The choice is stored for the telemetry work that follows, which will never
send code, prompts, file paths or repository names.

## Verifying a change

```sh
cd apps/desktop && bun run typecheck && bun test
cd apps/studio  && bun run typecheck && bun test && bun run build
bun run --cwd packages/redrob build --single --skip-install
cd apps/desktop && bun run prepare-engine && bun run package --dir && bun run smoke
```

`smoke` launches the packaged app with `--smoke-test`. The app starts the bundled engine, checks that an
authenticated health request succeeds and an unauthenticated one gets 401, then exits 0.

## Roadmap

| Milestone | Scope                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0 (this) | Shell, bundled engine, sign-in, projects, sessions (chat, changes, terminal), en/ko, Windows installer, updater, CI smoke and CLI install checks |
| M1        | Contest engine: blind build-off with rival-vendor builders, verification, pairwise judge, gates, `redrob buildoff`                               |
| M2        | Quality Lab: `redrob bench --replay`, head-to-head against the human patch, quality percentile, judge reliability checks with no human labels    |
| M3        | Build-off interface                                                                                                                              |
| M4        | Refinement rounds, standard mined from the repo automatically, Linux packages                                                                    |
| M5        | Fleet View, macOS on Apple Silicon                                                                                                               |
| M6        | Conflict radar, shared engine daemon with the CLI, macOS on Intel                                                                                |
| M7        | Remote runtimes, enterprise policy                                                                                                               |
