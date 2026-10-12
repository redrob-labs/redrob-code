# apps/desktop

The Electron shell for Redrob Code Desktop: main process and preload only. The interface is
`apps/studio`. Design of record: `docs/DESKTOP.md`.

- **The CLI stays vanilla.** Never copy the bundled engine onto PATH or into a CLI install directory
  (`~/.redrob/bin`, `~/bin`, `%LOCALAPPDATA%\Redrob\bin`). The only way this app installs the CLI is by
  running the official installer (`src/main/cli.ts`). `isCurlInstall` / `isWindowsInstallerInstall`
  recognise a CLI by its location, so writing there breaks `redrob upgrade`.
- **Artifact names start `redrob-code-desktop-`.** `install` downloads `redrob-<target>.<ext>` from the
  same release; `test/misc.test.ts` fails if the two could ever collide.
- **One bridge.** Every IPC channel is named in `src/shared/bridge.ts` and implemented in
  `src/preload/index.ts` and `src/main/index.ts`. The interface talks to the engine over HTTP itself; add
  a channel only for what a web page cannot do.
- **Secrets stay out of the renderer.** The Console API key goes from the device-flow response straight
  to the engine (`src/main/sign-in.ts`). The renderer only ever holds the engine's random local credential.
- **The renderer is served from `oc://renderer`**, which the engine's CORS allowlist already accepts.
  Do not load it from `file://`: that origin is `null` and the engine refuses it.
- **No native modules.** The main process and preload are bundled into `out/` by `script/build.ts` and
  nothing else ships in `app.asar` (`!node_modules/**/*` in the builder config). The terminal uses the
  engine's pty service.
- **The handshake prefix is duplicated** from `packages/redrob/src/cli/cmd/serve.ts`;
  `test/listening.test.ts` pins it.

Verify with `bun run typecheck`, `bun test`, and on a real build
`bun run prepare-engine && bun run package --dir && bun run smoke`.
