# Redrob Code

Redrob Code, the AI coding agent for your terminal.

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.ko.md">한국어</a>
</p>

[![Redrob Code Terminal UI](packages/identity/screenshot.png)](https://github.com/redrob-labs/redrob-code)

---

Redrob Code is the AI coding agent for your terminal, a fork of opencode with Korean as a first-class locale.

Redrob Code is a fork of [opencode](https://github.com/anomalyco/opencode), released
under the MIT License. It is not affiliated with, endorsed by, or supported by the
opencode project or its maintainers: the name is used here only to say where this
software came from.

What the fork changes: a different provider model (a single Redrob workspace endpoint
rather than per-vendor keys), Korean as a first-class locale, and a reduced package set
aimed at the terminal client rather than the hosted console. Releases have their own
version line starting at `0.1.0`; the upstream version a build is based on is recorded in
`UPSTREAM_VERSION` and stated in the release notes. See `docs/VERSIONING.md`.

### Installation

```bash
curl -fsSL https://raw.githubusercontent.com/redrob-labs/redrob-code/main/install | bash
```

That serves [`install`](./install) from this repository, so the script you run is the one you
can read here. It picks the first writable location from this list:

1. `$REDROB_INSTALL_DIR`: explicit override
2. `$XDG_BIN_DIR`: XDG Base Directory path
3. `$HOME/bin`: used if it exists or can be created
4. `$HOME/.redrob/bin`: fallback

```bash
REDROB_INSTALL_DIR=/usr/local/bin curl -fsSL https://raw.githubusercontent.com/redrob-labs/redrob-code/main/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://raw.githubusercontent.com/redrob-labs/redrob-code/main/install | bash
```

Then start it in any project:

```bash
redrob
```

### Authentication

Redrob Code talks to the Redrob console at <https://console.redrob.ai> and authenticates
with a workspace API key. There is no password login and no loopback OAuth callback.

The quickest way to get a key onto a machine is to let the console issue one. Run:

```bash
redrob providers login --provider redrob
```

Pick **Connect Redrob**. The CLI shows a short code such as `K7QM-2XR9` and opens
<https://console.redrob.ai/connect> in a browser, on this machine if it has one. Sign in to
the console, approve the code, and the CLI collects the key it issues. Inside a running
session the same thing is on the `/connect` dialog.

This is RFC 8628's device authorization grant, so it works over SSH, in a container, and on
a host with no browser: the page can be opened on a phone or a laptop instead. The code is
good for ten minutes. Approving it creates an ordinary workspace API key that the console's
key list can revoke. It adds no credit.

Pasting a key still works, and is what to use when the console cannot be reached from the
machine or the key was issued out of band. Pick **Paste an API key from console.redrob.ai**,
or set the environment variable:

```bash
export REDROB_API_KEY=rrk_<prefix>_<secret>
```

Either way the credential ends up in the same place, `auth.json` under the Redrob data
directory, readable only by you. `redrob providers list` prints the exact path.

### Models

The Redrob console is the only provider. The model catalog is fetched at startup from
`GET https://console.redrob.ai/api/backend/v1/models`, so new models appear without a
CLI upgrade. List what your key can reach:

```bash
redrob models
```

Currently available:

| Model                    | Use                                               |
| ------------------------ | ------------------------------------------------- |
| `redrob/auto`            | Console-routed default; picks a model per request |
| `redrob/gpt-5.6-sol`     | GPT-5.6 Sol, the larger OpenAI-family model       |
| `redrob/gpt-5.6-terra`   | GPT-5.6 Terra, cheaper GPT-5.6 tier               |
| `redrob/claude-opus-5`   | Claude Opus 5, strongest coding and agentic work  |
| `redrob/claude-sonnet-5` | Claude Sonnet 5, balanced coding                  |
| `redrob/claude-fable-5`  | Claude Fable 5, long-form writing                 |

`redrob/auto` is the default. Pick a specific model for a session with
`redrob --model redrob/claude-opus-5`.

`redrob-ai` and `redrob-translate` have been retired and are no longer valid model ids. Replace
them with `redrob/auto` in any config, agent, or command that still names them.

### Agents

Two primary agents ship built in. Cycle between them with `Tab` (`Shift+Tab` to go back).

- **build**: the default agent; runs tools according to the configured permissions
- **plan**: denies all edit tools, for analysis and exploring unfamiliar code

Two subagents are also available and can be invoked from a message:

- **`@general`**: multi-step research and parallel units of work
- **`@explore`**: fast codebase search and orientation

### Configuration

| Scope   | Path                                                |
| ------- | --------------------------------------------------- |
| Global  | `~/.config/redrob/redrob.json` or `redrob.jsonc`    |
| Project | `./redrob.json` or `./redrob.jsonc`, and `.redrob/` |

Project config is merged over global config. Ask the agent to edit your config and it
loads a built-in skill with the real schema, so `redrob` can also configure itself.

`.opencode/` is still read as a legacy location so older checkouts keep working; write
new files to `.redrob/`.

### Scope

Redrob Code is the engine, the CLI and the terminal UI, plus the SDKs and plugin
surface built on them. It ships no graphical interface of its own: no desktop
shell, no web UI, no browser front end.

**Redrob Work is the only GUI.** It drives this engine over the HTTP API that
`redrob serve` exposes, selecting a project per request with the
`x-redrob-directory` header. The API, ACP and MCP surfaces are the contract
between the two; keep them stable.

### Development

```bash
bun install
bun dev                      # run the CLI from source
bun typecheck                # all packages
cd packages/core && bun test # tests run per package, never from the repo root
```

`bun@1.3.14` is required; the pre-push hook enforces it.

See [docs/BRANCHING.md](./docs/BRANCHING.md) for the branch model, how to open a pull
request, and how upstream releases are absorbed, the last of which is the operation
that matters most in a fork and the one most easily got wrong.
