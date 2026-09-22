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
- `redrob-reblend` ranks a LOCAL transport at `http://127.0.0.1:4096` and health-probes
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

| field | required | notes |
| --- | --- | --- |
| `model` | yes | `redrob/auto` routes through the Console; a local provider id targets a local model |
| `messages` | yes | `system` / `user` / `assistant` / `tool` roles |
| `tools` | no | **presence changes who executes them — see below** |
| `tool_choice` | no | `auto` \| `none` \| a named function |
| `stream` | no | default `false`; `true` returns SSE |
| `max_tokens` | no | |
| `temperature` | no | ignored for models that fix their own sampling |
| `reasoning_effort` | no | passed through where the provider accepts it |

Unknown fields are ignored rather than rejected, so a newer client can talk to an
older engine without a version check.

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
2. `$HOME/.redrob/bin/redrob` — where `install.sh` already installs
3. `PATH`
4. absent → the product offers a one-click install that runs the official installer
   (GitHub Releases, verified against `SHA256SUMS`)

### One daemon, not one per product

A shared record at `$HOME/.redrob/run/server.json`, mode `0600`:

```json
{ "port": 51234, "pid": 8412, "secret": "…", "version": "0.1.7" }
```

The first product that needs the engine starts it; the rest attach. Required
behaviour: liveness check before attaching, recovery from a stale record whose pid is
gone, and reconnection by attached products when an upgrade restarts the daemon.

Per-product processes were considered and rejected: with local inference, N processes
means the same weights loaded N times, which defeats the reason for doing this.

That file is the auth boundary — it carries the Basic secret. It is per-user by
location and must stay `0600`; a multi-user machine gets one daemon per user, never a
shared one.

### Capability negotiation replaces pinning

No product pins an engine version. Auto-update would otherwise break clients
silently. Instead `/capabilities` (promoted, formerly `/experimental/capabilities`,
handler at `packages/redrob/src/server/routes/instance/httpapi/handlers/experimental.ts:39-41`)
grows an entry:

```json
{ "chatCompletions": { "version": 1, "callerTools": true, "stream": true } }
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

## 4. Migration

| product | change |
| --- | --- |
| redrob-browser | point `sidecar_client.cc:592` at `/v1/chat/completions`; its host-owned tool loop already matches the contract |
| redrob-office | drop the bundled binary and the packaging guard; point the engine route at the local daemon; keep its editor-owned tool loop |
| redrob-cowork | drop the download-and-stage step and the duplicate alias copy; keep driving the session API for agent work |
| redrob-reblend | either pass the local base URL and allow loopback HTTP in its sidecar, or delete the LOCAL transport that cannot work |
| redrob-canvas, redrob-query, redrob-recall | optional: switching from the Console to the local daemon buys them one shared login |
| redrob-extension, redrob-cad | unchanged; they want engine-owned tools and the session API already serves that |

## Open items

- Whether `tools` and engine-owned tools may ever be combined in one turn. Deferred
  out of v1 deliberately.
- Which local inference providers the registry should resolve first.
