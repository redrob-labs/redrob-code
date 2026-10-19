# The local engine API

Every Redrob product needs the same three things from this engine: a credential the
user only supplies once, model and provider routing, and — the reason this document
exists — the option of inference that does not leave the machine. None of those is
the agent. So the shared surface is a plain inference endpoint, and the agent stays
where it already is.

This document is the design of record for that endpoint, for promoting the
`/experimental` surface, and for shipping the engine as one shared install instead
of a copy inside every product.

## Why this is being written now

Three products were already written against a local engine endpoint that has never
existed.

- `redrob-browser` POSTs to `<engine>/experimental/external/chat/completions` and
  streams the SSE reply (`sources/chrome/browser/redrob/sidecar_client.cc:592`). No
  such route is served: the experimental group registers `capabilities`, `console`,
  `tool`, `worktree`, `session` and `resource` and nothing else
  (`packages/redrob/src/server/routes/instance/httpapi/groups/experimental.ts:91-101`).
  The string `external` does not appear anywhere under `packages/redrob/src/server`.
- `redrob-shape` ranks a LOCAL transport at `http://127.0.0.1:4096` and health-probes
  it, but its sidecar rejects any non-HTTPS base URL, so that transport cannot carry a
  request even when the probe succeeds.
- `redrob-office` compiles this engine from source at release time and ships it inside
  its installer, with a packaging guard that refuses to build without it — and never
  calls it.

The products that DO drive the engine successfully (`redrob-cowork`, `redrob-cad`)
drive its own session API. The ones that tried to give the engine an OpenAI face are
the ones that are broken. That is the signal this design follows: serve the OpenAI
face for real, at one stable path, and stop pretending the session API is one.

## 1. `POST /v1/chat/completions`

The core path. There is no alias: `/experimental/external/chat/completions` is not
served, and `redrob-browser`'s call site moves to `/v1/chat/completions` in the same
wave (see Migration).

### Where it sits

On `packages/llm` and the provider registry — NOT on `Session`. A chat completion is
stateless and a session is not; mapping one onto the other is what forces an
ephemeral-session-per-request design and a fake OpenAI face over an event bus. The
route resolves the provider and credential exactly as the agent does, then makes the
model call directly.

This is also what makes local inference work: a locally served model is just another
provider the registry resolves, and callers see no difference.

### Request

An OpenAI chat-completions subset:

| field              | required | notes                                                                               |
| ------------------ | -------- | ----------------------------------------------------------------------------------- |
| `model`            | yes      | `redrob/auto` routes through the Console; a local provider id targets a local model |
| `messages`         | yes      | `system` / `user` / `assistant` / `tool` roles                                      |
| `tools`            | no       | **presence changes who executes them — see below**                                  |
| `tool_choice`      | no       | `auto` \| `none` \| a named function                                                |
| `stream`           | no       | default `false`; `true` returns SSE                                                 |
| `max_tokens`       | no       |                                                                                     |
| `temperature`      | no       | ignored for models that fix their own sampling                                      |
| `reasoning_effort` | no       | passed through where the provider accepts it                                        |
| `redrob_context`   | no       | Redrob extension: `{ page_url, page_title }` of the page the caller is on — see Skill arming |

Unknown fields are ignored rather than rejected, so a newer client can talk to an
older engine without a version check.

### Skill arming

A skill arms itself — its body is added to the request without anyone loading it —
when its frontmatter declares `keywords:` or `urls:` (or the nested
`autoInject: { keywords, url }` block; both spellings merge):

```markdown
---
name: browser-gmail
description: Use when the task is reading or drafting mail in Gmail.
urls:
  - https://mail.google.com/*
keywords:
  - gmail
---
```

- **keywords** match the last `user` message, case-insensitively, on word boundaries
  (`ai` does not match `said`). A keyword ending in Hangul needs no boundary after it,
  so `홈택스` matches `홈택스에서`.
- **urls** match `redrob_context.page_url`. The scheme is ignored, `*` stays inside one
  path segment, `**` crosses segments, and a trailing `/*` in `urls:` covers the whole
  site including its root.
- Armed bodies go in as one extra `system` message after the caller's own system
  messages, labelled with what armed each one. A skill with neither list never arms
  and behaves as before; in agent sessions an armable skill is left out of the standing
  skill list and appears only when it arms.

`redrob-browser` sends `redrob_context` on every task turn to the built-in engine: the
agent's own tab once it has opened one, else the http(s) tab the user started from. It
never sends it to a user's own provider. The engine ships ten site skills under
`packages/core/src/plugin/skill/browser/` (Gmail, Google Calendar, Notion, GitHub,
Slack, 네이버 메일, 네이버 검색, 카카오, 홈택스 조회, 쿠팡 주문 조회) and the
`skill-writer` skill, which saves a repeated instruction as a new
`~/.config/redrob/skills/<name>/SKILL.md`.

### Tool ownership is decided by the request

This is the whole design. One rule, no modes to configure:

- **`tools` present → the CALLER owns them.** The engine does not execute anything.
  It emits `tool_calls` and ends the turn with `finish_reason: "tool_calls"`. The
  caller executes them and sends a follow-up request carrying `role: "tool"`
  messages. Standard OpenAI semantics, and stateless.
- **`tools` absent → the ENGINE owns them.** Present behaviour: the engine selects
  and runs its own tools and returns final text.

In v1 the two do not mix. Declaring `tools` disables engine-side tools. One
predictable rule beats three configurable ones, and it is the rule every caller
already assumes.

Why it has to be this way: `redrob-office`'s tools edit an open document held in the
renderer. `redrob-browser`'s tools drive a live tab. Neither can be executed by the
engine — handed over, the engine would edit the disk instead of the document. Caller
ownership is not a preference, it is the only correct answer for those hosts.

### Streaming

`stream: true` returns `text/event-stream`: OpenAI delta chunks, then
`data: [DONE]`. Tool calls stream as `delta.tool_calls` fragments keyed by index, the
way callers already parse them.

### Auth

Inbound uses the server's existing HTTP Basic (`packages/redrob/src/server/auth.ts:18`).
Callers do NOT send a Console key.

Outbound uses the engine's OWN Console credential — `REDROB_API_KEY`, then the
credential store, then `auth.json` (`packages/core/src/console-key.ts:34-72`). This is
the single-login property: one `redrob providers login` and every product is
authenticated, because no product holds a key of its own on this path.

### Errors

The OpenAI error envelope, so existing client error handling works unchanged:

```json
{ "error": { "message": "...", "type": "...", "code": "..." } }
```

One code is load-bearing: when the engine itself has no Console credential, the reply
is `401` with `code: "engine_not_authenticated"`. That is the only condition under
which a client should offer a sign-in action. Clients must branch on this code and not
on the message text, which is localized. A client that offers sign-in on any failure
reports a network timeout as "please log in" — that shipped, and it is what this code
exists to prevent.

## 2. Promoting `/experimental`

Every `/experimental/*` route is promoted out of the experimental namespace and
becomes part of the stable surface.

This is safe to do as one breaking rename, because **no product calls any of them.**
The only callers are this repo's own generated SDKs
(`packages/sdk/js/src/gen`, `packages/sdk/js/src/v2/gen`), which `httpapi-codegen`
regenerates from the route definitions. The one external reference to an experimental
path is `redrob-browser`'s dead completions call, which this design replaces anyway.

So: rename the paths, regenerate the SDKs, and delete the experimental namespace. No
compatibility window is owed to callers that do not exist.

## 3. One shared install, no bundling, no pin

Products stop shipping a copy of this binary. `redrob-office` drops ~145 MB from its
installer and drops its packaging guard; `redrob-cowork` drops its download-and-stage
step.

### Resolution order

1. `REDROB_CODE_BIN` — explicit override, development
2. `$HOME/.redrob/bin/redrob` — where `install.sh` already installs (and where Redrob Launcher
   links the copy it installs)
3. Windows: `%LOCALAPPDATA%\Redrob\bin\redrob.exe` — where the setup.exe and the MSI install
4. `PATH`
5. absent → the product offers a one-click install that runs the official installer
   (GitHub Releases, verified against `SHA256SUMS.txt`)

### One daemon, not one per product

Built. `redrob serve --register` is the daemon; `redrob service start | status | stop | restart`
drives it by hand, and `redrob service start --json` prints the record for a caller in another
language (the launcher is Rust). The record is `$HOME/.redrob/run/server.json`
(`REDROB_RUN_DIR` overrides the folder), mode `0600`:

```json
{ "id": "…", "version": "0.5.0", "url": "http://127.0.0.1:4096", "port": 4096, "pid": 8412, "secret": "…" }
```

`id` is random per start, so a client that saw another id knows the daemon restarted. `secret`
is the Basic password (username `redrob`), drawn fresh on every start: a stale record never opens
a running server, and an app that loses its connection re-reads the file rather than keeping a
secret of its own.

The first app that needs the engine starts it; the rest attach. `connectOrStart` in
`@redrob-labs/sdk/daemon` (JavaScript) and `packages/redrob/src/daemon/connect.ts` (the CLI) do
the required steps: a liveness check before attaching (`/api/health` with the record's secret), a
stale record whose pid is gone is removed, a healthy daemon of another version is stopped and
replaced (an upgrade), and the new record is awaited.

Attached apps are counted. `POST /api/clients {app, pid}` attaches, `POST
/api/clients/:id/heartbeat` keeps it (expected within `ttlMs`, 90 s; the SDK's `attach()` does this
for you), `DELETE /api/clients/:id` detaches, `GET /api/clients` lists them with `idleForMs` and
the daemon's `idleExitAfterMs`. A registered daemon exits once nobody has needed it for
`--idle-exit` minutes (default 10; 0 keeps it up): no app attached, no request in flight, and no
authorized request since -- so an app that only calls the API (the Rust apps: Shape, Canvas, Query,
Recall, through `redrob-engine-client`) keeps it alive by using it, and it never leaves under a
request still being answered. Status polls (`/api/health`, `/api/clients`) do not count: the
launcher's engine card asks every few seconds. It also exits when another daemon has taken over
the record. `redrob acp --attach` makes the ACP face a thin client of the daemon instead of an
engine of its own, so ACP hosts (Design, Cut, CAD, Browser) share the one process too.

Per-product processes were considered and rejected: with local inference, N processes
means the same weights loaded N times, which defeats the reason for doing this.

One daemon also means an app can no longer hand "its" engine a private config through the
environment (`REDROB_CONFIG`, `REDROB_SERVER_URL`, …): env is per process, and the process is
shared. What an app needs to tell the engine about one directory goes in a file the engine reads
for that directory: `<state>/directories/<key>/redrob.json` (`<state>` is `$XDG_STATE_HOME/redrob`,
else `~/.local/state/redrob`; `<key>` is the SHA-256 of the absolute, normalised directory path,
lower-cased on Windows). `directoryConfigDir(dir)` in `@redrob-labs/sdk/daemon` and
`ConfigPaths.directoryConfigDir` in the engine compute it. It merges after the global config and
before the project's own `redrob.json`, exactly where `REDROB_CONFIG` merged, so the user's files
still win; it lives outside the project tree so it never collides with them or shows up in git.
After writing it the app calls `POST /instance/dispose` for the directory and the next request
rebuilds the instance on the new file. Anything a plugin used to read from the spawning app's env
belongs in this file too (for example under a key the plugin owns), because the daemon's env is
nobody's.

The same goes for *which app is calling*. The agent runner labels its provider requests with
`x-redrob-app` from `REDROB_APP`, which only names the app that started a private engine. On the
shared daemon `POST /v1/chat/completions` reads the labels from the request instead: send
`x-redrob-app: <app>` and `x-redrob-session: <your session id>` and the engine forwards them to
the provider as `x-redrob-app` and `X-Session-Id` (plus `x-session-affinity`), the names the
runner uses, so the Console groups both paths alike. Absent headers forward nothing; no other
request header crosses.

Detecting the engine from another language, without the SDK: `redrob service status --json`
prints the record as one JSON line and exits `0` when a healthy daemon is registered, prints
`null` and exits `1` when none is. `redrob service start --json` prints the record (starting the
daemon when needed) and exits `0`, or exits non-zero with the reason on stderr. A missing `redrob`
binary (not on `PATH`, no `REDROB_BIN`) is the "engine not installed" case: the app should say so
and point at the launcher or the Code install, never fall back to calling a provider directly --
two paths would mean the user cannot tell whether masking applied. The Rust crate
`redrob-engine-client` (`crates/engine-client` in this repository, pinned by apps as a git
dependency on the engine tag they target) wraps all of this for Shape, Canvas, Query, Recall and
the launcher.

That file is the auth boundary — it carries the Basic secret. It is per-user by
location and must stay `0600`; a multi-user machine gets one daemon per user, never a
shared one.

### Capability negotiation replaces pinning

No product pins an engine version. Auto-update would otherwise break clients
silently. Instead `/capabilities` (promoted, formerly `/experimental/capabilities`,
handler at `packages/redrob/src/server/routes/instance/httpapi/handlers/experimental.ts:39-41`)
grows an entry:

```json
{ "chatCompletions": { "version": 1, "callerTools": true, "stream": true }, "sharedDaemon": { "version": 1 } }
```

A product declares the MINIMUM capability it needs, never a version number. If the
entry is missing or its `version` is below that minimum, the product tells the user to
run `redrob upgrade` instead of failing with a transport error.

### Backward compatibility, as rules rather than a promise

- The contract is versioned by PATH (`/v1/...`), never by engine version.
- Adding a request or response field is allowed. Removing one, or changing what one
  means, requires `/v2`.
- When `/v2` appears, `/v1` keeps being served for two minor versions.
- A contract test in this repo pins the v1 request and response schema and fails CI
  when a field is removed or its type changes. Without that test "we keep
  compatibility" is a sentence, not a guarantee.

### The app bridge: the engine drives the app

The routes above let an app call the engine. The reverse -- the agent driving a running
app -- is the app bridge: the app serves its own MCP tool server on loopback and
registers it with the daemon (`POST /v1/apps/register`, heartbeat, `DELETE`). The
daemon connects it as MCP server `app:<name>` for every session and drops it when the
app unregisters or its heartbeats stop; a bridged app also counts as attached, so the
idle-exit clock does not run while it is up. Only loopback URLs are accepted and
nothing is written to the user's config. Full contract, payloads and SDK/Rust examples:
[docs/APP-BRIDGE.md](APP-BRIDGE.md). `redrob apps list` shows who is bridged.

## 4. Migration

| product                                    | change                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| redrob-browser                             | point `sidecar_client.cc:592` at `/v1/chat/completions`; its host-owned tool loop already matches the contract               |
| redrob-office                              | drop the bundled binary and the packaging guard; point the engine route at the local daemon; keep its editor-owned tool loop |
| redrob-cowork                              | drop the download-and-stage step and the duplicate alias copy; keep driving the session API for agent work                   |
| redrob-shape                               | either pass the local base URL and allow loopback HTTP in its sidecar, or delete the LOCAL transport that cannot work        |
| redrob-canvas, redrob-query, redrob-recall | optional: switching from the Console to the local daemon buys them one shared login                                          |
| redrob-extension, redrob-cad               | unchanged; they want engine-owned tools and the session API already serves that                                              |

## Open items

- Whether `tools` and engine-owned tools may ever be combined in one turn. Deferred
  out of v1 deliberately.
- Which local inference providers the registry should resolve first.
