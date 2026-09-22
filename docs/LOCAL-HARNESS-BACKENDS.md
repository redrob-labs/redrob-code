# Local harness backends, for every product at once

How Codex and Claude Code become an option in *all* Redrob products — office,
cowork, browser, design, extension, canvas, query, recall, cad, reblend — from one
implementation in this engine, rather than ten adapters in ten repositories.

Companion documents: `docs/PROVIDER-AUTH.md` (what each vendor permits, and why we
never hold a token) and `docs/LOCAL-ENGINE-API.md` (the `/v1/chat/completions`
contract this rides on). redrob-cowork `docs/CODEX-RUNTIME.md` holds the working
prototype that proved the subprocess mechanics.

## The mistake this corrects

The first adapter was written inside redrob-cowork, behind that app's engine-spawn
hook. It works, and it found real bugs, but its home is wrong: it gives Cowork a
Codex option and gives the other nine products nothing. Ten products would mean
ten adapters, ten settings screens, ten credential stories, and ten places for the
subprocess environment bug described below to be re-introduced.

The adapter belongs here instead, because every product already reaches a model
through this engine — and the ones that still call the Console directly are exactly
the ones `/v1/chat/completions` was built to bring in.

## The mechanism already exists

`packages/core/src/config/plugin/local-provider.ts` admits a provider when two
conditions hold: the package is exactly `@ai-sdk/openai-compatible` (the trusted,
pinned one the Console provider itself uses), and the URL is on this machine or
network. That door was opened for Ollama, LM Studio, llama.cpp and vLLM, whose only
shared trait is that they **speak OpenAI-compatible chat-completions over a local
address**.

A harness can meet the same bar. Put a small local server in front of `codex exec`
or `claude -p` that speaks chat-completions, and it is admissible through a path
this engine already trusts — no new provider-loading machinery, no widening of the
arbitrary-npm-package refusal, no second credential store.

```
codex exec  /  claude -p          subprocess; holds its OWN credential
        ▲
  harness shim                    local, OpenAI-compatible, 127.0.0.1
        ▲
  redrob-code engine              registered via the existing local-provider path
        ▲
  POST /v1/chat/completions       one receiving route
        ▲
  office · cowork · browser · design · extension · canvas · query · recall · cad · reblend
```

Models then select a backend by id — `codex/<model>`, `claude-code/<model>` — which
is the same way a local model is already selected, and needs no new request field.

### Why a shim here, having argued against one in Cowork

`docs/CODEX-RUNTIME.md` recommends *against* a protocol shim in Cowork and this
document recommends one. That is not an inconsistency, it is the surface being
different, and the difference is the whole argument.

A Cowork shim would have to emulate the **OpenCode session API** — sessions, the SSE
event shape, permissions — which is large, ours, and still changing. A shim that
falls subtly behind produces bugs that look like model bugs. A shim here emulates
**chat-completions**, which is small, published, frozen, and not ours to change. The
first is a maintenance liability; the second is an adapter against a stable
contract.

## Two tiers, and most products only need the first

This is the part that cannot be papered over: **Codex and Claude Code are agent
harnesses, not completion endpoints.** They run their own loop with their own
tools. So there are two levels of support, not one.

**Chat tier — all ten products.** Prompt in, text out. The harness's loop runs but
its tools are constrained to nothing the caller did not ask for. This covers every
product's ordinary AI use: rewrite this paragraph, summarise this sheet, answer
this question. It maps cleanly onto `/v1/chat/completions` and needs no per-product
code.

**Agent tier — cowork, code, cad.** The harness runs a real agent loop against a
workspace. chat-completions cannot express this, because that contract's rule is
"tools present → the caller owns them", and here the *runtime* owns the loop. This
needs ACP or a session surface, and it is separate work. Do not let it block the
chat tier.

A safety point that belongs in the chat tier and is easy to miss: a harness given a
writable sandbox will happily read and edit the user's filesystem. A user asking
Office to reword a sentence has not consented to an agent walking their disk. So
the shim pins `--sandbox read-only` with approvals set to never, and network access
off, unless a caller is on the agent tier and asked for more. The prototype already
defaults this way; the shim must not relax it for convenience.

The tool-ownership split surveyed earlier decides which products need more than the
chat tier:

- **No tool protocol** — query, recall, reblend. Chat tier is the whole story.
- **Host-owned tools** — office, browser, canvas. Chat tier works today. Giving the
  harness their tools needs MCP servers (`~/.codex/config.toml`, or per-invocation
  `--config mcp_servers.…`) or Codex app-server's `dynamicTools`, which lets the
  tool stay in the host process. `dynamicTools` is the better fit and is labelled
  experimental by OpenAI, so it is not a foundation to build on yet.
- **Engine-owned tools** — cowork, cad, extension, design. Under a harness backend
  the engine's own tools are not in the loop at all. That is the agent tier's
  problem to solve.

## What the products have to do

Almost nothing, which is the point.

Nothing at all to *work*: a product that names a model and calls the engine gets
the new backends when the engine gets them.

One thing to be *usable*: somewhere to turn it on, and three states rather than
one — runtime not installed, installed but not signed in, ready. Collapsing those
into "unavailable" strands the user, because the remedy differs and we are not
allowed to offer the vendor's login ourselves. The remedy we may show is "run
`codex login`" or "run `claude`".

Credentials need no work anywhere. The harness holds its own; the engine holds none
for it. Cowork already demonstrates the pattern for the BYOK case — it stores no
provider key and treats the engine's `auth.json` as the single source of truth.

## Sequencing

1. **Land `/v1/chat/completions`.** It is the receiving route for everything above
   and it is not merged: the handler exists on `feature/v1-chat-completions`, and
   `test:httpapi` fails without an `httpapi-exercise` scenario. Also needs the
   `chatCompletions` capability flag, the SSE OpenAPI patch, and a route test.
   Nothing here can ship before it.
2. **Build the shim with both backends.** One local chat-completions server; two
   normalizers behind it. The prototype's split — event folding separated from the
   subprocess — is what makes the second runtime a second normalizer rather than a
   second architecture. Reuse it rather than re-deriving it.
3. **Register through the local-provider path**, and surface the backends in
   `/v1/providers` with their three states so a product can render settings
   without hardcoding a list.
4. **Verify against real binaries.** Neither runtime is installed on the build
   host, so the live path — a real subscription actually paying for a turn — is
   unproven until someone runs it on a machine with `codex` and `claude` signed in.
5. **Then the agent tier**, for cowork, code and cad, over ACP.

Two things to carry forward rather than discover later. `claude -p`'s
`stream-json` event schema has not been checked against the real binary — only the
flags are confirmed — so step 2 starts by reading it, not by assuming it mirrors
Codex's JSONL. And Anthropic has announced, then paused, a change that moves
third-party subscription usage onto a capped monthly credit; it currently still
draws from the subscription, but the trajectory is known, so the Claude backend
should surface usage state rather than assume it is free.
