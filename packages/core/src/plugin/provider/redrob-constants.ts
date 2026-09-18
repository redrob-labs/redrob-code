// Leaf module holding the console.redrob.ai provider constants. Kept dependency-free
// so both RedrobPlugin (packages/core/src/plugin/provider/redrob.ts) and the dynamic
// ModelsDev.Service (packages/core/src/models-dev.ts) can import them without creating
// an import cycle through the heavier plugin/event modules.

// The real console.redrob.ai API is an OpenAI-standard base URL. SDKs and the dynamic
// catalog fetch append paths to it: /chat/completions for inference and /models for the
// OpenAI-standard model listing. It is served by the trusted @ai-sdk/openai-compatible
// package (pinned by ConfigProviderPlugin).
export const CONSOLE_URL = "https://console.redrob.ai/api/backend/v1"
export const CONSOLE_PACKAGE = "@ai-sdk/openai-compatible"
// Every served console model publishes `capabilities.maxContextTokens: 1_000_000`. Held as one
// constant because the value is uniform across the six ids, and used as the no-key fallback
// context window. A zero here is not cosmetic: `usable()` in packages/redrob/src/session/overflow.ts
// returns 0 and `isOverflow()` returns false whenever `limit.context === 0`, so a zero silently
// disables auto-compaction for the whole offline path.
export const CONSOLE_CONTEXT_TOKENS = 1_000_000
// The listing publishes no output-token ceiling, so the fallback uses this CLI's own per-request
// output cap (ProviderTransform.OUTPUT_TOKEN_MAX). Requests are unaffected — `maxOutputTokens()`
// already clamps to the same number, and treated 0 as "use the cap" — but a non-zero value is what
// lets `usable()` reserve room for the reply instead of returning 0.
export const CONSOLE_OUTPUT_TOKENS = 32_000

// The known console models, verified against the live GET ${CONSOLE_URL}/models listing with a
// real key: it serves exactly these six ids. `redrob-ai` and `redrob-translate` are retired ids
// that the product no longer offers, so they must never appear in a catalog, a default, or any
// model id this CLI sends. `thinking` mirrors whether the listing's `capabilities.thinkingLevels`
// is non-empty, which is the only capability that differs between the six. Per-model pricing is
// deliberately not mirrored here: it is the console's to change, and a stale rate shown offline is
// worse than none, so the no-key fallback reports no cost and lets the live listing supply it.
// This list is the single source of the static/no-key fallback catalog: the dynamic listing is
// authoritative when a key is present, and every static registration (ModelsDev fallback,
// RedrobPlugin V2, V1 seed) is derived from here so they cannot drift. Ids and names are raw
// strings so the V1 side can build its own branded ids and object keys without cross-package
// branded-type friction.
export const CONSOLE_MODELS = [
  // `auto` publishes the full thinking range (low | medium | high | xhigh | max) in the live
  // listing's `capabilities.thinkingLevels`, so claiming otherwise offline would hide the router's
  // own reasoning control. Verified against GET ${CONSOLE_URL}/models and the console's public
  // pricing catalogue.
  { id: "auto", name: "Redrob Auto", thinking: true },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", thinking: false },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", thinking: false },
  { id: "claude-opus-5", name: "Claude Opus 5", thinking: true },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", thinking: true },
  { id: "claude-fable-5", name: "Claude Fable 5", thinking: true },
] as const
// Structural, not `(typeof CONSOLE_MODELS)[number]`, so callers that build one entry (the primary
// backfill) are not forced to widen a literal union.
export type ConsoleModelInfo = { readonly id: string; readonly name: string; readonly thinking: boolean }
export const CONSOLE_MODEL_IDS = CONSOLE_MODELS.map((model) => model.id)
// The primary/default console model, kept as a single id for callers that need exactly one. `auto`
// is the console's own router and the canonical default for this CLI, so it is the id every caller
// falls back to.
export const CONSOLE_MODEL = CONSOLE_MODELS[0]
export const CONSOLE_MODEL_ID = CONSOLE_MODEL.id
