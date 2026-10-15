# Provider authentication

How a user connects their own model access to this engine, and therefore to every
product built on it. One credential store, read by all of them, so a user sets up
once rather than once per app.

The goal this answers is "let people use the Claude or ChatGPT access they already
pay for". Part of that is available and part of it is not, and the split is not
technical — it is what each vendor's terms permit a third-party application to do.
So the shapes are enumerated first, then the design.

Not legal advice. Every claim below links the document it came from, checked
2026-09-22; re-check before shipping, because three of these pages changed in the
first half of this year.

## What each vendor actually allows a third-party app

| vendor | "sign in" for a third-party app | user's own API key | user's consumer subscription |
| --- | --- | --- | --- |
| Anthropic | **No** — expressly forbidden | Yes, expressly | **No** — prohibited, enforced with account bans |
| OpenAI | No self-serve registration; granted case by case | Yes | Only by embedding OpenAI's own Codex runtime |
| Google Gemini | OAuth exists but bills *your* Cloud project | Yes — the named supported path | **No** — prohibited, enforced with bans |
| GitHub Copilot | **Yes** — the Copilot SDK, officially | Yes | Yes, billed to the user's own subscription |
| OpenRouter | **Yes** — OAuth PKCE | Yes | n/a (it is BYOK by design) |
| Azure OpenAI | **Yes** — Microsoft Entra ID | Yes | n/a (user's own Azure resource) |
| Amazon Bedrock | No (SigV4 / Bedrock API keys) | Yes — the user's own AWS account | n/a |
| AWS Kiro | **No** | Kiro API key, subscriber-only | Only by driving the user's own installed CLI |

Sources, and the sentences that decide it:

- Anthropic, [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance):
  "Anthropic does not permit third-party developers to offer Claude.ai login into
  their own applications, or to route requests through Free, Pro, or Max plan
  credentials on behalf of their users." And developers "should use API key
  authentication through Claude Console or a supported cloud provider." Enforced:
  accounts were banned for spoofing the Claude Code harness, and our own upstream
  (OpenCode) removed Claude subscription AND Claude API key support on 2026-02-19
  citing Anthropic legal requests ([The Register,
  2026-02-20](https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546)).
  The only sanctioned subscription route is shipping Claude Code itself,
  unmodified, with its auth methods intact.
- OpenAI, [Codex authentication](https://developers.openai.com/codex/auth/):
  "Sign in with ChatGPT" is documented for OpenAI's own surfaces only. Third
  parties that have it — Zed, OpenClaw — get there by wrapping OpenAI's own Codex
  runtime ([Zed](https://zed.dev/blog/chatgpt-subscription-in-zed)). Treat that as
  a revocable product decision, not an entitlement: no terms clause grants it.
- Google, [Gemini CLI FAQ](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/faq.md):
  "the supported and secure method is to use a Vertex AI or Google AI Studio API
  key", and piggybacking Gemini CLI's OAuth "may be grounds for immediate
  suspension or termination". Enforced in
  [this thread](https://github.com/google-gemini/gemini-cli/discussions/20632).
  Note the Gemini API terms also say the API is "not for consumer use" and
  require paid services for EEA/UK/CH users.
- GitHub, [Copilot SDK OAuth setup](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth):
  "Copilot requests are made on behalf of each authenticated user, using their
  Copilot subscription… Your app never handles model API keys." A device flow is
  documented for exactly our case, "Desktop applications where users interact
  directly".
- OpenRouter, [OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth):
  send the user to `/auth` with a `code_challenge`, exchange the code for a
  **user-controlled API key**. Loopback callback on any port, plus a headless
  paste mode.
- Azure, [Entra ID auth](https://learn.microsoft.com/azure/ai-services/openai/how-to/managed-identity)
  with the [device authorization grant](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code).
- Kiro, [Authentication](https://kiro.dev/docs/getting-started/authentication/):
  subscriber `ksk_` API keys exist; the only documented embed path is driving the
  user's own CLI over [ACP](https://kiro.dev/docs/cli/acp/).

### What this means for the product ask

"Sign in with Claude" and "Sign in with ChatGPT", as buttons in our own apps
spending the user's consumer subscription, are not available. Building them means
impersonating a first-party client, and the vendors ban accounts for it — the cost
lands on our users, not on us.

What IS available, and covers most of the intent:

1. **BYOK for every provider.** Anthropic and Google both name this as the
   supported path for third-party tools. A user with a Claude API key or a Gemini
   key connects in one step.
2. **Three real sign-in buttons**: GitHub Copilot, OpenRouter, Azure OpenAI. The
   first two are the interesting ones — Copilot spends the user's own Copilot
   subscription with GitHub's blessing, and OpenRouter fronts Claude and GPT
   models behind an account login, which is the closest legitimate thing to what
   was asked for.
3. **Optionally, unmodified first-party binaries.** Shipping Claude Code or the
   Codex CLI as-is and letting it authenticate itself is sanctioned by both
   vendors. It is a different product shape — their harness, not ours — so it is
   recorded here as available rather than recommended.

## Design

### One store, in the engine

Credentials live where they already live: `Global.Path.data/auth.json`, through
`packages/redrob/src/auth`, whose `Info` union is already `Oauth | Api |
WellKnown`. `packages/core/src/console-key.ts` reads env → credential store →
that file, and `Integration` resolves a connection into a `Credential.Value` for
the provider layer.

Nothing new is invented, because the point is that products stop having stores of
their own. Today Office keeps keys in `userData/ai-settings.json`, Design in the
macOS keychain, the extension in `chrome.storage.local`, Query and Recall in
separate keyring services — five stores that never read each other, which is why
a user logs in again in every app.

A product reads the engine's store instead. It keeps its own as a cache if it
wants, but the engine's file is the source of truth, and the engine is what makes
the call.

### Products never hold a key

`POST /v1/chat/completions` (see `docs/LOCAL-ENGINE-API.md`) already carries the
engine's credential outward and takes none from the caller. That is the whole
mechanism: a product names a `model`, the engine resolves the provider and its
credential. Adding a provider is then a change in one place, and every downstream
app gets it without shipping a release.

This also removes a class of bug rather than moving it: a product that holds no
key cannot leak one, log one, or sync one.

### Connecting a provider

`redrob providers login` already implements both shapes — a generic OAuth flow
with `authorize()` plus `auto` and `code` callbacks, and an API-key path
(`packages/redrob/src/cli/cmd/providers.ts`).

**An earlier draft of this section proposed four new `/v1/providers` routes to expose
it. That was wrong: the routes already exist.** They are the `server.integration`
group on the v2 surface, and they already carry everything a settings page needs.
Building the `/v1/providers` set would have been a duplicate surface over the same
credential store, with two code paths to keep in agreement.

What exists, and what it replaces from that proposal:

| proposed | already exists |
| --- | --- |
| `GET /v1/providers` | `GET /api/integration` — returns `Integration.Info`, whose `methods` array is a union of `OAuthMethod`, `KeyMethod` and `EnvMethod`, plus `connections` for what is already connected |
| `POST /v1/providers/:id/login` (key) | `POST /api/integration/:integrationID/connect/key` |
| `POST /v1/providers/:id/login` (oauth) | `POST /api/integration/:integrationID/connect/oauth` |
| `POST /v1/providers/:id/login/:attempt` | `POST /api/integration/attempt/:attemptID/complete`, with `GET /api/integration/attempt/:attemptID` for status and `DELETE` to cancel |
| `DELETE /v1/providers/:id/credential` | `DELETE /api/credential/:credentialID` |

So the engine-side work for BYOK is **done**, and the real work is product-side:
making an app use these routes instead of its own store. Office keeps keys in
`userData/ai-settings.json`, Design in the macOS keychain, the extension in
`chrome.storage.local`, Query and Recall in separate keyring services — five stores
that never read each other, which is the whole reason a user logs in again in every
app. Cowork already does it the right way: it stores no provider key and posts the
key once to the engine (`apps/server/src/redrob-auth.ts`), treating the engine's
`auth.json` as the single source of truth. That is the pattern to copy.

Three rules still hold for those routes, and they are worth restating because they
are what makes the single store safe:

1. **The key never comes back out.** A response says a credential is present and
   names it; it never returns the secret. A product that cannot read the key
   cannot mishandle it, and this is also what keeps the loopback API from becoming
   a credential-exfiltration endpoint if something else on the machine reaches it.
2. **The OAuth code stays in the engine.** The product gets the URL to open and an
   opaque id, nothing else — the same split `apps/shell/src/main/redrob-connect.ts`
   already uses between Electron's main process and its renderer.
3. **No caller-supplied base URL.** Keep this ban. It is not only policy: the
   config layer admits a new openai-compatible provider only at a local address
   (`isLocalEndpoint`), and honouring an arbitrary URL from a request would
   forward the engine's own credential to whatever host the caller named. A local
   model is selected by its `provider/model` id.

### Which providers get a login button

Ship BYOK for all of them. Add OAuth only where the vendor documents it for third
parties: GitHub Copilot, OpenRouter, Azure OpenAI. Anthropic, Google, OpenAI and
Bedrock get an API-key field and no button.

The UI should say which is which. A user who expects "sign in with Claude" and
finds a key field deserves the reason in one line — that Anthropic requires an API
key for third-party tools — rather than being left to assume the feature is
missing.

### Order of work

1. `GET /v1/providers` and the API-key path. This alone gives Office, Cowork and
   Design one shared BYOK setup, and needs no vendor negotiation.
2. OpenRouter OAuth. Smallest real sign-in button and the one that reaches Claude
   and GPT models legitimately.
3. GitHub Copilot via the Copilot SDK. A user's existing Copilot subscription,
   sanctioned, with a documented device flow for desktop.
4. Azure OpenAI via Entra device code.

## What must not be built

- Reusing Claude Code's or the Codex CLI's OAuth client id to spend a consumer
  subscription from our own harness. Anthropic and Google both ban accounts for
  it; our upstream removed the code under legal pressure.
- Collecting, storing or proxying Claude.ai session tokens. Named explicitly in
  Anthropic's compliance page.
- Paying for or intermediating another vendor's usage on a user's behalf. Also
  named there, and it is what "just put our key in it" would amount to.

A compliance check worth keeping: this repository currently contains no Anthropic
OAuth client id and no `claude.ai` endpoint. The only hardcoded vendor OAuth is
xAI's (`packages/redrob/src/plugin/xai.ts`). Keep it that way.
