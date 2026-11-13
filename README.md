# Redrob Code

Redrob Code, the AI coding agent for your terminal.

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.ko.md">한국어</a>
</p>

[![Redrob Code Terminal UI](packages/identity/screenshot.png)](https://github.com/redrob-labs/redrob-code)

---

Redrob Code is the AI coding agent for your terminal, with Korean as a first-class locale.

Redrob Code is released under the MIT License. Third-party license notices are in
[NOTICE.md](./NOTICE.md).

What Redrob Code offers: a single Redrob workspace endpoint
rather than per-vendor keys, Korean as a first-class locale, and a package set
aimed at the terminal client rather than a hosted console. Releases have their own
version line starting at `0.1.0`. See `docs/VERSIONING.md`.

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

#### Windows

In PowerShell (Windows PowerShell 5.1 or PowerShell 7), no administrator rights needed:

```powershell
irm https://raw.githubusercontent.com/redrob-labs/redrob-code/main/install.ps1 | iex
```

[`install.ps1`](./install.ps1) picks the x64, x64-baseline or arm64 build for your CPU, checks it
against the release's `SHA256SUMS.txt`, installs `redrob.exe` into `%USERPROFILE%\.redrob\bin`
(where Redrob Desktop looks, and where `redrob upgrade` can replace it) and adds that folder to
your user PATH. A specific version, or a different folder:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/redrob-labs/redrob-code/main/install.ps1))) -Version 0.18.16
$env:REDROB_INSTALL_DIR = "D:\tools\redrob"; irm https://raw.githubusercontent.com/redrob-labs/redrob-code/main/install.ps1 | iex
```

`REDROB_VERSION`, `REDROB_NO_MODIFY_PATH=1` and `REDROB_CONNECT=rc_...` do the same as
`-Version`, `-NoModifyPath` and `-Connect`. The signed `.msi` and `setup.exe` on the
[releases page](https://github.com/redrob-labs/redrob-code/releases) install into
`%LOCALAPPDATA%\Redrob\bin` instead.

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

| Model                    | Use                                                     |
| ------------------------ | ------------------------------------------------------- |
| `redrob/claude-opus-5-5` | Claude Opus 5.5, the default; runs at `medium` thinking |
| `redrob/gpt-5.6-sol`     | GPT-5.6 Sol, the larger OpenAI-family model             |
| `redrob/gpt-5.6-terra`   | GPT-5.6 Terra, cheaper GPT-5.6 tier                     |
| `redrob/claude-opus-5`   | Claude Opus 5, strong coding and agentic work           |
| `redrob/claude-sonnet-5` | Claude Sonnet 5, balanced coding                        |
| `redrob/claude-fable-5`  | Claude Fable 5, long-form writing                       |

`redrob/claude-opus-5-5` at `medium` thinking is the default. Pick another model for a session with
`redrob --model redrob/claude-sonnet-5`, and another thinking level with
`redrob run --variant high` (`ctrl+t` cycles it in the TUI).

`redrob/auto` has been retired: a saved choice of it, or a config, agent, or command that still
names it, now runs `redrob/claude-opus-5-5`. `redrob-ai` and `redrob-translate` have been retired
and are no longer valid model ids. Replace them with `redrob/claude-opus-5-5`.

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

Project config files live in `.redrob/`.

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

See [docs/BRANCHING.md](./docs/BRANCHING.md) for the branch model and how to open a pull
request.
