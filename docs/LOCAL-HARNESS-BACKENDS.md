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
  harness their tools means a **stdio MCP server** (`~/.codex/config.toml`, a
  project-scoped `.codex/config.toml`, or per-invocation
  `--config mcp_servers.…`; Claude Code takes `--mcp-config` plus
  `--strict-mcp-config`). Codex app-server's `dynamicTools` would let the tool stay
  inside the host process instead, and an earlier draft of this document called that
  "the better fit" — that recommendation is **withdrawn** on evidence:

  - OpenAI's stability warning got *broader*, not narrower. The
    [2026-06-24 snapshot](http://web.archive.org/web/20260624142043/https://developers.openai.com/codex/app-server)
    carried no production warning at all and scoped "experimental" to the WebSocket
    transport; today's page says "The app-server command and WebSocket transport are
    experimental and aren't supported for production workloads."
  - app-server has **no row at all** in OpenAI's
    [Feature Maturity](https://developers.openai.com/codex/feature-maturity) table.
  - `dynamicTools` is double-experimental: gated behind
    `capabilities.experimentalApi`, and **absent from the generated
    `ThreadStartParams` bindings**, so the field you must send is one you hand-write
    against no type. It has already changed wire shape once — `LegacyDynamicToolSpec`
    exists as the compat scar, with `exposeToContext` replaced by the *inverted*
    `deferLoading`.
  - No protocol version, no breaking-change log, and an open regression in the `-c`
    MCP path under app-server mode
    ([openai/codex#39537](https://github.com/openai/codex/issues/39537)).

  The counter-signal is real and is why this is "revisit in a quarter" rather than
  "avoid": Zed's ACP adapter *moved onto* app-server
  ([agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)),
  and OpenAI's own IDE surfaces run on it. The one thing MCP cannot give us is a tool
  whose implementation lives in our own process memory. When Office genuinely needs
  that, budget for re-porting `dynamicTools` at least once.
- **Engine-owned tools** — cowork, cad, extension, design. Under a harness backend
  the engine's own tools are not in the loop at all. That is the agent tier's
  problem to solve.

## The vendor risk is asymmetric, and it sets the order

An earlier draft of this document said driving the unmodified binary is "the
documented exception". That was too confident, and the correction matters enough to
change sequencing.

Anthropic began blocking third-party harnesses from Claude **subscription** billing
on **2026-04-04**, and the restriction is described as being extended to *all*
third-party harnesses
([claude-mem#1826](https://github.com/thedotmack/claude-mem/issues/1826), which links
the press coverage). OpenClaw is researching a `--method cli` path precisely because
direct OAuth token use has been blocked since then — so CLI-driving is the surviving
workaround, **not a safe harbour**. The same issue warns that spawning a `claude`
subprocess through the Agent SDK "is exactly the 'third-party harness' pattern
Anthropic is restricting". Anthropic's own June support article still says
subscription limits fund `claude -p` and third-party apps and that the metering
change is paused; treat the two together as a trajectory, not a guarantee.

OpenAI points the other way: it publishes the integration surface as a platform, and
LiteLLM openly ships a `chatgpt/` provider for subscription access.

Two consequences, both load-bearing:

1. **BYOK with the user's own API key is the first deliverable, not the fallback.**
   It is unaffected by any of the above, it is the path Anthropic and Google both
   name as the supported one for a third-party tool, and Office's policy is already
   open for it.
2. **Codex before Claude Code**, for business reasons rather than technical ones.

## Nothing off the shelf is reusable

Surveyed 2026-09-22. No existing project is production-credible for our requirement
— drive the local CLI *and* pass caller-supplied tools through:

- [claude-code-api-rs](https://github.com/ZhangHanDong/claude-code-api-rs) (177★,
  MIT) is the only mature native `tools` → `tool_calls` mapping, and it is Rust,
  five months without a commit, and ships with
  `use_interactive_sessions = false # Disabled by default due to stability issues`.
- [claude-code-openai-wrapper](https://github.com/RichardAtCT/claude-code-openai-wrapper)
  (622★) states in its own README that function calling is not supported.
- [codingworkflow/claude-code-api](https://github.com/codingworkflow/claude-code-api)
  (331★) is **GPL-3.0** — viral, so unusable in a shipped product.
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (52.8k★) looks like the
  obvious answer and is not: it never spawns the CLI. It performs the CLI's OAuth
  flow itself, stores the token, and calls the vendor backend — the exact
  architecture Anthropic blocked in April.
- LiteLLM, OpenRouter, Portkey, Helicone: no provider that drives a local Claude Code
  or Codex CLI.

Two specifics are worth copying rather than the repos: the **pooled long-lived CLI
process** model and the native tools mapping from claude-code-api-rs, and the trick of
launching with `--tools "" --setting-sources "" --system-prompt <the caller's>`, which
strips roughly 28k tokens of the harness's own agent prompt and built-in tools out of
every request. That second one is the concrete mechanism behind the chat tier — it is
what turns an agent harness into something that behaves like a completion endpoint.

## What the products have to do

Almost nothing, which is the point.

Nothing at all to *work*: a product that names a model and calls the engine gets
the new backends when the engine gets them.

One thing to be *usable*: somewhere to turn it on, and three states rather than
one — runtime not installed, installed but not signed in, ready. Collapsing those
into "unavailable" strands the user, because the remedy differs and we are not
allowed to offer the vendor's login ourselves. The remedy we may show is "run
`codex login`" or "run `claude`".

Both states are readable by ASKING the runtime, never by reading its credential
store: `claude auth status` exits 0 when signed in and 1 when not (its JSON field
names are undocumented, so the exit code is the contract), and Codex app-server
exposes `account/read`. A `claude -p` run also reports `apiKeySource` in its
`system`/`init` event.

Credentials need no work anywhere. The harness holds its own; the engine holds none
for it. Cowork already demonstrates the pattern for the BYOK case — it stores no
provider key and treats the engine's `auth.json` as the single source of truth.

## Sequencing

1. **BYOK with the user's own API key.** Moved to the front — see the vendor-risk
   section. The engine side is **already built** — `GET /api/integration` returns
   each integration's `methods` (OAuth / Key / Env) and its `connections`, and
   `connect/key`, `connect/oauth`, the attempt routes and `DELETE /api/credential`
   complete the set. An earlier draft of `docs/PROVIDER-AUTH.md` proposed a parallel
   `/v1/providers` surface; that is withdrawn, because it would duplicate these over
   the same store. The remaining work is product-side: make an app use them instead
   of its own key store. Cowork already does (`apps/server/src/redrob-auth.ts`).
2. **Use the user's OWN binary.** The Codex SDK pins `@openai/codex` exactly and
   resolves the executable from its own bundled platform packages unless
   `codexPathOverride` is passed — so the default behaviour runs a SECOND copy we
   downloaded, not the one the user signed in to. That re-creates the duplicate-engine
   problem this whole effort exists to remove. Detect the user's install and pass the
   path explicitly. Claude Code is proprietary with no redistribution grant, so it is
   the only option there anyway, which makes both runtimes the same shape.
3. **Build the shim with both backends.** One local chat-completions server; two
   normalizers behind it. The prototype's split — event folding separated from the
   subprocess — is what makes the second runtime a second normalizer rather than a
   second architecture. Reuse it rather than re-deriving it.
4. **Give the harness our tools through a stdio MCP server.** Not app-server. Know
   the defaults before wiring: Codex's `startup_timeout_sec` is 10, `tool_timeout_sec`
   is 60, and `required = true` makes `codex exec` exit with an error rather than
   silently running without our server.
5. **Register through the local-provider path**, and report the harness backends
   through `GET /api/integration` alongside every other integration, with their
   three states, so a product renders settings from one list rather than hardcoding
   a vendor set that goes stale.
6. **Verify against real binaries.** Neither runtime is installed on the build
   host, so the live path — a real subscription actually paying for a turn — is
   unproven until someone runs it on a machine with `codex` and `claude` signed in.
7. **Then the agent tier**, for cowork, code and cad, over ACP.

One thing to carry forward rather than discover later: Anthropic has announced, then
paused, a change moving third-party subscription usage onto a capped monthly credit,
so the Claude backend should surface usage state rather than assume it is free. Note
also that `claude -p`'s credential precedence puts the OAuth login **last** —
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`
and `ANTHROPIC_PROFILE` in the environment all silently take over billing, and
`--bare` never reads the OAuth login at all. That is the same class of bug as the
Codex env trap, in the opposite direction: the shim must build the child environment
from an allow-list for both runtimes.

`claude -p`'s `stream-json` schema IS now mapped, so step 3 does not start by
guessing: `system`/`init` carries `session_id`, `tools`, `mcp_servers` and
`apiKeySource`; assistant text and `tool_use` blocks are in
`assistant.message.content`; and the final `result` message carries
`subtype` (`success` or `error_*`), `is_error`, `total_cost_usd` and `modelUsage`.
Read cost from `modelUsage`, not `usage` — `usage` covers the main loop only and
undercounts subagents. Pin non-interactive behaviour with
`--permission-mode dontAsk --permission-prompts none`, and read-only with
`--tools "Read,Glob,Grep" --disallowedTools "Edit" "Write" "NotebookEdit" "Bash" "mcp__*"`.
