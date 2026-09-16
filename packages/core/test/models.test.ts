import { describe, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@redrob-code/core/effect/app-node-builder"
import { LayerNodePlatform } from "@redrob-code/core/effect/app-node-platform"
import { Flag } from "@redrob-code/core/flag/flag"
import { Credential } from "@redrob-code/core/credential"
import { Integration } from "@redrob-code/core/integration"
import { ConsoleBotChallenge, isBotChallengeBody, ModelsDev } from "@redrob-code/core/models-dev"
import { it } from "./lib/effect"

// The reworked ModelsDev.Service fetches the OpenAI-standard listing from
// GET https://console.redrob.ai/api/backend/v1/models with `Authorization: Bearer <REDROB_API_KEY>`.
// These tests drive that fetch through a mock HttpClient and assert the fallback + non-fatal
// behavior. test/preload.ts pins REDROB_DISABLE_MODELS_FETCH=true; each fetching test flips it
// off inside a save/restore so the mutation never leaks to other files in the bun process.
const ORIGINAL_DISABLE_FETCH = Flag.REDROB_DISABLE_MODELS_FETCH
const ORIGINAL_API_KEY = process.env["REDROB_API_KEY"]
afterAll(() => {
  Flag.REDROB_DISABLE_MODELS_FETCH = ORIGINAL_DISABLE_FETCH
  if (ORIGINAL_API_KEY === undefined) delete process.env["REDROB_API_KEY"]
  else process.env["REDROB_API_KEY"] = ORIGINAL_API_KEY
})

const CONSOLE_MODELS_URL = "https://console.redrob.ai/api/backend/v1/models"

// The EXACT body returned by the live GET https://console.redrob.ai/api/backend/v1/models
// endpoint (verified against the real console with a real key): an OpenAI-standard listing with the
// six served models, each carrying vendor-specific `redrob` pricing and `capabilities` blocks the
// internal schema does not model. Pinned verbatim so a decoding regression against the real shape —
// including the `owned_by` field and those extra blocks — fails here. `redrob-ai` and
// `redrob-translate` are deliberately absent: they are retired ids the console does not serve.
const modelList = {
  object: "list",
  data: [
    {
      id: "auto",
      object: "model",
      created: 1767225600,
      owned_by: "redrob",
      redrob: { inputPricePerMillionUsd: 0.6, outputPricePerMillionUsd: 1.8, inputMultiplier: 1, outputMultiplier: 1 },
      capabilities: {
        shortContextTokens: 272000,
        maxContextTokens: 1000000,
        thinkingLevels: [],
        fastMode: false,
        requiresProviderDataShare: false,
        // The live console publishes these per model; `auto` advertises the widest set.
        imageInput: true,
        audioInput: true,
        fileInput: true,
        imageOutput: true,
        maxOutputTokens: 64000,
      },
    },
    {
      id: "gpt-5.6-sol",
      object: "model",
      created: 1767225600,
      owned_by: "redrob",
      redrob: {
        inputPricePerMillionUsd: 4,
        outputPricePerMillionUsd: 20,
        inputMultiplier: 6.67,
        outputMultiplier: 11.11,
        longContextInputPricePerMillionUsd: 8,
        longContextOutputPricePerMillionUsd: 30,
      },
      capabilities: {
        shortContextTokens: 272000,
        maxContextTokens: 1000000,
        thinkingLevels: [],
        fastMode: false,
        requiresProviderDataShare: false,
      },
    },
    {
      id: "gpt-5.6-terra",
      object: "model",
      created: 1767225600,
      owned_by: "redrob",
      redrob: {
        inputPricePerMillionUsd: 2,
        outputPricePerMillionUsd: 12,
        inputMultiplier: 3.33,
        outputMultiplier: 6.67,
        longContextInputPricePerMillionUsd: 4,
        longContextOutputPricePerMillionUsd: 18,
      },
      capabilities: {
        shortContextTokens: 272000,
        maxContextTokens: 1000000,
        thinkingLevels: [],
        fastMode: false,
        requiresProviderDataShare: false,
      },
    },
    {
      id: "claude-opus-5",
      object: "model",
      created: 1767225600,
      owned_by: "redrob",
      redrob: {
        inputPricePerMillionUsd: 5,
        outputPricePerMillionUsd: 25,
        inputMultiplier: 8.33,
        outputMultiplier: 13.89,
      },
      capabilities: {
        shortContextTokens: 200000,
        maxContextTokens: 1000000,
        thinkingLevels: ["low", "medium", "high", "max"],
        fastMode: true,
        requiresProviderDataShare: false,
        // Image in and nothing else: the shape most of the console's vision models publish.
        imageInput: true,
      },
    },
    {
      id: "claude-sonnet-5",
      object: "model",
      created: 1767225600,
      owned_by: "redrob",
      redrob: { inputPricePerMillionUsd: 3, outputPricePerMillionUsd: 15, inputMultiplier: 5, outputMultiplier: 8.33 },
      capabilities: {
        shortContextTokens: 200000,
        maxContextTokens: 1000000,
        thinkingLevels: ["low", "medium", "high", "max"],
        fastMode: true,
        requiresProviderDataShare: false,
      },
    },
    {
      id: "claude-fable-5",
      object: "model",
      created: 1767225600,
      owned_by: "redrob",
      redrob: {
        inputPricePerMillionUsd: 10,
        outputPricePerMillionUsd: 50,
        inputMultiplier: 16.67,
        outputMultiplier: 27.78,
      },
      capabilities: {
        shortContextTokens: 200000,
        maxContextTokens: 1000000,
        thinkingLevels: ["low", "medium", "high", "max"],
        fastMode: true,
        requiresProviderDataShare: true,
      },
    },
  ],
}

// Every served console model, which the static/no-key fallback catalog must also surface, sorted so
// it can be compared against Object.keys(...).sort().
const CONSOLE_MODEL_IDS = ["auto", "claude-fable-5", "claude-opus-5", "claude-sonnet-5", "gpt-5.6-sol", "gpt-5.6-terra"]

// The display names the static fallback must publish, in CONSOLE_MODELS order.
const FALLBACK_MODEL_NAMES = [
  ["auto", "Redrob Auto"],
  ["gpt-5.6-sol", "GPT-5.6 Sol"],
  ["gpt-5.6-terra", "GPT-5.6 Terra"],
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-fable-5", "Claude Fable 5"],
]

interface MockState {
  body: string
  status: number
  calls: Array<{ url: string; authorization: string | null }>
}

const makeMockClient = (state: Ref.Ref<MockState>) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* Ref.update(state, (s) => ({
        ...s,
        calls: [...s.calls, { url: request.url, authorization: request.headers["authorization"] ?? null }],
      }))
      const s = yield* Ref.get(state)
      return HttpClientResponse.fromWeb(request, new Response(s.body, { status: s.status }))
    }),
  )

// ModelsDev resolves the console key from the environment or from the credential store, so the
// store is stubbed here rather than standing up a database. `storedKey` undefined means the user
// never ran `redrob providers login`.
const credentialLayer = (storedKey?: string) =>
  Layer.succeed(
    Credential.Service,
    Credential.Service.of({
      all: () => Effect.succeed([]),
      list: () =>
        Effect.succeed(
          storedKey === undefined
            ? []
            : [
                new Credential.Info({
                  id: Credential.ID.make("cred_test"),
                  integrationID: Integration.ID.make("redrob"),
                  label: "default",
                  value: { type: "key", key: storedKey },
                }),
              ],
        ),
      get: () => Effect.succeed(undefined),
      create: () => Effect.die("Credential.create is not used by ModelsDev"),
      update: () => Effect.void,
      remove: () => Effect.void,
    }),
  )

const buildLayer = (state: Ref.Ref<MockState>, storedKey?: string) =>
  // Layer.fresh so each test gets its own cachedInvalidateWithTTL state rather than
  // reusing the process-global MemoMap entry from a previous test.
  Layer.fresh(
    AppNodeBuilder.build(ModelsDev.node, [
      [LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, makeMockClient(state))],
      [Credential.node, credentialLayer(storedKey)],
    ]),
  )

const provided = <A, E>(state: Ref.Ref<MockState>, eff: Effect.Effect<A, E, ModelsDev.Service>) =>
  eff.pipe(Effect.provide(buildLayer(state)))

const okState = (): MockState => ({ body: JSON.stringify(modelList), status: 200, calls: [] })

describe("ModelsDev Service", () => {
  beforeEach(() => {
    Flag.REDROB_DISABLE_MODELS_FETCH = false
    process.env["REDROB_API_KEY"] = "rrk_test_key"
  })
  afterEach(() => {
    Flag.REDROB_DISABLE_MODELS_FETCH = ORIGINAL_DISABLE_FETCH
    delete process.env["REDROB_API_KEY"]
  })

  it.live("get() fetches the console /models endpoint with a Bearer token when a key is set", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(okState())
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      // A single 'redrob' provider populated from the /models data.
      expect(Object.keys(result)).toEqual(["redrob"])
      expect(result["redrob"].env).toEqual(["REDROB_API_KEY"])
      expect(result["redrob"].api).toBe("https://console.redrob.ai/api/backend/v1")
      // Every live model is surfaced; the extra `owned_by`, `redrob` and `capabilities` fields are
      // tolerated and ignored.
      expect(Object.keys(result["redrob"].models).sort()).toEqual(CONSOLE_MODEL_IDS)
      // release_date derives from the OpenAI `created` seconds field when present.
      expect(result["redrob"].models["auto"].release_date).toBe("2026-01-01")
      expect(result["redrob"].models["claude-opus-5"].release_date).toBe("2026-01-01")

      const final = yield* Ref.get(state)
      expect(final.calls.length).toBe(1)
      expect(final.calls[0].url).toBe(CONSOLE_MODELS_URL)
      expect(final.calls[0].authorization).toBe("Bearer rrk_test_key")
    }),
  )

  it.live("get() degrades to the static console fallback when the fetch returns 401", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make({ ...okState(), status: 401, body: "unauthorized" })
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(Object.keys(result)).toEqual(["redrob"])
      expect(Object.keys(result["redrob"].models).sort()).toEqual(CONSOLE_MODEL_IDS)
      expect(result["redrob"].models["auto"].name).toBe("Redrob Auto")
      expect(result["redrob"].models["claude-opus-5"].name).toBe("Claude Opus 5")
      // The request was still attempted (proves wiring), then degraded non-fatally.
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBeGreaterThanOrEqual(1)
      expect(final.calls[0].url).toBe(CONSOLE_MODELS_URL)
    }),
  )

  it.live("get() degrades to the static fallback when the response body is unparseable", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make({ ...okState(), status: 200, body: "{not json" })
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(Object.keys(result["redrob"].models).sort()).toEqual(CONSOLE_MODEL_IDS)
    }),
  )

  it.live("get() fetches using a credential stored by `redrob providers login` with no env key", () =>
    Effect.gen(function* () {
      delete process.env["REDROB_API_KEY"]
      const state = yield* Ref.make(okState())
      const result = yield* ModelsDev.Service.use((s) => s.get()).pipe(
        Effect.provide(buildLayer(state, "rrk_stored_key")),
      )

      expect(Object.keys(result["redrob"].models).sort()).toEqual(CONSOLE_MODEL_IDS)
      const final = yield* Ref.get(state)
      expect(final.calls.map((call) => call.url)).toEqual([CONSOLE_MODELS_URL])
      expect(final.calls[0]?.authorization).toBe("Bearer rrk_stored_key")
    }),
  )

  it.live("get() uses the static fallback and issues NO request when no REDROB_API_KEY is set", () =>
    Effect.gen(function* () {
      delete process.env["REDROB_API_KEY"]
      const state = yield* Ref.make(okState())
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      // The no-key fallback lists every served console model, matching the live listing.
      expect(Object.keys(result["redrob"].models).sort()).toEqual(CONSOLE_MODEL_IDS)
      expect(result["redrob"].models["claude-fable-5"].name).toBe("Claude Fable 5")
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  // The no-key fallback is the only catalog a user without a key ever sees, so it must name exactly
  // the ids the live console serves. `redrob-ai`/`redrob-translate` were pinned here for a while and
  // are now retired, so listing them advertised models the console will not resolve. The ids and
  // names are spelled out rather than read from CONSOLE_MODELS so a drift in the constant fails this
  // test instead of silently agreeing with it.
  it.live("the static fallback catalog names exactly the models the console serves", () =>
    Effect.gen(function* () {
      delete process.env["REDROB_API_KEY"]
      const state = yield* Ref.make(okState())
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )

      const provider = result["redrob"]
      expect(provider.name).toBe("Redrob")
      expect(provider.env).toEqual(["REDROB_API_KEY"])
      expect(provider.api).toBe("https://console.redrob.ai/api/backend/v1")
      expect(provider.npm).toBe("@ai-sdk/openai-compatible")
      expect(Object.keys(provider.models)).toEqual(FALLBACK_MODEL_NAMES.map(([id]) => id))
      for (const [id, name] of FALLBACK_MODEL_NAMES) {
        expect(provider.models[id].name).toBe(name)
        expect(provider.models[id].tool_call).toBe(true)
        expect(provider.models[id].provider).toEqual({
          npm: "@ai-sdk/openai-compatible",
          api: "https://console.redrob.ai/api/backend/v1",
        })
      }
      // Retired ids must never be presented as models.
      expect(provider.models["redrob-ai"]).toBeUndefined()
      expect(provider.models["redrob-translate"]).toBeUndefined()
    }),
  )

  it.live("get() uses the static fallback and issues NO request when REDROB_DISABLE_MODELS_FETCH is set", () =>
    Effect.gen(function* () {
      Flag.REDROB_DISABLE_MODELS_FETCH = true
      const state = yield* Ref.make(okState())
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(Object.keys(result["redrob"].models).sort()).toEqual(CONSOLE_MODEL_IDS)
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("get() is single-flight and caches across calls until refresh invalidates", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(okState())
      const results = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          const many = yield* Effect.all([svc.get(), svc.get(), svc.get()], { concurrency: "unbounded" })
          // A second get() after the cache is warm must not issue another request.
          const again = yield* svc.get()
          return { many, again }
        }),
      )
      for (const result of results.many) expect(Object.keys(result["redrob"].models).sort()).toEqual(CONSOLE_MODEL_IDS)
      const final = yield* Ref.get(state)
      // cachedInvalidateWithTTL collapses the concurrent + repeat gets into a single fetch.
      expect(final.calls.length).toBe(1)
    }),
  )

  it.live("refresh() invalidates the cache so the next get() re-fetches /models", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(okState())
      const after = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          yield* svc.get()
          yield* svc.refresh(true)
          return yield* svc.get()
        }),
      )
      expect(Object.keys(after["redrob"].models).sort()).toEqual(CONSOLE_MODEL_IDS)
      const final = yield* Ref.get(state)
      // One fetch before refresh, one after invalidation.
      expect(final.calls.length).toBe(2)
    }),
  )
})

// OpenAI's listing shape has no field for a price or a context window, so the console publishes both
// under vendor keys of its own: `redrob` for the per-million rates and `capabilities` for the window
// plus the thinking/fast/data-share switches. These were decoded and thrown away until now, which
// left every console model reporting `limit.context: 0` — and `isOverflow()` in
// packages/redrob/src/session/overflow.ts returns false unconditionally at a zero context, so no
// session on a Redrob model ever auto-compacted. Everything below reads the same pinned live body as
// the suite above, so it needs no key and no network.
describe("ModelsDev console model metadata", () => {
  beforeEach(() => {
    Flag.REDROB_DISABLE_MODELS_FETCH = false
    process.env["REDROB_API_KEY"] = "rrk_test_key"
  })
  afterEach(() => {
    Flag.REDROB_DISABLE_MODELS_FETCH = ORIGINAL_DISABLE_FETCH
    delete process.env["REDROB_API_KEY"]
  })

  const fetched = Effect.fn(function* () {
    const state = yield* Ref.make(okState())
    const result = yield* provided(
      state,
      ModelsDev.Service.use((s) => s.get()),
    )
    return result["redrob"].models
  })

  it.live("projects the published per-million rates into cost", () =>
    Effect.gen(function* () {
      const models = yield* fetched()
      // `cost` is USD per million tokens, the same unit the console quotes, so the numbers carry
      // across unscaled (packages/redrob/src/session/session.ts divides by 1_000_000 when billing).
      expect(models["claude-opus-5"].cost).toEqual({ input: 5, output: 25, tiers: undefined })
      expect(models["claude-sonnet-5"].cost).toEqual({ input: 3, output: 15, tiers: undefined })
      expect(models["claude-fable-5"].cost).toEqual({ input: 10, output: 50, tiers: undefined })
      expect(models["auto"].cost).toEqual({ input: 0.6, output: 1.8, tiers: undefined })
    }),
  )

  it.live("projects a long-context card into a cost tier keyed to the short-context threshold", () =>
    Effect.gen(function* () {
      const models = yield* fetched()
      // Sol and Terra are the two ids with a separate rate above `shortContextTokens`; the tier size
      // is that threshold, matching how ModelsDevPlugin already projects `context_over_200k`.
      expect(models["gpt-5.6-sol"].cost).toEqual({
        input: 4,
        output: 20,
        tiers: [{ input: 8, output: 30, tier: { type: "context", size: 272_000 } }],
      })
      expect(models["gpt-5.6-terra"].cost).toEqual({
        input: 2,
        output: 12,
        tiers: [{ input: 4, output: 18, tier: { type: "context", size: 272_000 } }],
      })
      // The Claude ids publish no long-context card, so they get no tier rather than a half-priced
      // one built from a missing rate.
      expect(models["claude-opus-5"].cost?.tiers).toBeUndefined()
    }),
  )

  it.live("projects maxContextTokens into limit.context and leaves limit.input unset", () =>
    Effect.gen(function* () {
      const models = yield* fetched()
      for (const id of CONSOLE_MODEL_IDS) {
        expect(models[id].limit.context).toBe(1_000_000)
        // This CLI's own ceiling, except where the console publishes a cap of its own (auto does).
        expect(models[id].limit.output).toBe(id === "auto" ? 64_000 : 32_000)
        // shortContextTokens is a pricing threshold, not an input cap. Setting limit.input from it
        // would make `usable()` stop reserving room for the reply.
        expect(models[id].limit.input).toBeUndefined()
      }
    }),
  )

  it.live("publishes the effort variants each console model actually offers", () =>
    Effect.gen(function* () {
      const models = yield* fetched()
      // The three Claude ids publish low/medium/high/max; auto, Sol and Terra publish none in this
      // fixture.
      expect(models["claude-opus-5"].reasoning).toBe(true)
      expect(models["claude-sonnet-5"].reasoning).toBe(true)
      expect(models["claude-fable-5"].reasoning).toBe(true)
      expect(models["auto"].reasoning).toBe(false)
      expect(models["gpt-5.6-sol"].reasoning).toBe(false)
      expect(models["gpt-5.6-terra"].reasoning).toBe(false)
      // Levels are published VERBATIM, not mapped onto OpenAI's three-value effort scale: the
      // console validates `thinking` against its own enum, so mapping would drop xhigh and max.
      // ProviderTransform turns these into `thinking` for this provider, never `reasoning_effort`.
      expect(models["claude-opus-5"].reasoning_options).toEqual([
        { type: "effort", values: ["low", "medium", "high", "max"] },
      ])
      // A model that publishes no levels still publishes an EMPTY list rather than undefined, which
      // is what tells reasoningVariants to synthesise nothing at all.
      for (const id of ["auto", "gpt-5.6-sol", "gpt-5.6-terra"]) {
        expect(models[id].reasoning_options).toEqual([])
      }
    }),
  )

  it.live("advertises the modalities each console model publishes, and no others", () =>
    Effect.gen(function* () {
      const models = yield* fetched()
      // The console's chat endpoint accepts `image_url` and `input_audio` parts and publishes per
      // model which of them that model can read. This is load-bearing rather than cosmetic:
      // ProviderTransform consults capabilities.input[modality] and replaces an image with the text
      // "ERROR: Cannot read image (this model does not support image input)" when it is false, so a
      // model whose modalities are understated can never receive an attachment at all.
      expect(models["auto"].modalities).toEqual({
        input: ["text", "image", "audio"],
        output: ["text", "image"],
      })
      expect(models["auto"].attachment).toBe(true)
      // fileInput has no modality of its own here -- a PDF arrives as a file part and is gated by
      // the mime mapping -- but it does mean there is an attachment to offer.
      expect(models["claude-opus-5"].modalities).toEqual({ input: ["text", "image"], output: ["text"] })
      expect(models["claude-opus-5"].attachment).toBe(true)
      // A model that publishes no modality flags stays text-only. Understating is the safe
      // direction: the button is missing rather than the request failing.
      for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "claude-sonnet-5", "claude-fable-5"]) {
        expect(models[id].modalities).toEqual({ input: ["text"], output: ["text"] })
        expect(models[id].attachment).toBe(false)
      }
      for (const id of CONSOLE_MODEL_IDS) {
        expect(models[id].tool_call).toBe(true)
        expect(models[id].temperature).toBe(true)
      }
    }),
  )

  it.live("takes the published reply cap when there is one, and this CLI's ceiling otherwise", () =>
    Effect.gen(function* () {
      const models = yield* fetched()
      expect(models["auto"].limit.output).toBe(64000)
      // No published cap on this one, so it keeps this CLI's ceiling.
      expect(models["claude-opus-5"].limit.output).toBe(32_000)
    }),
  )

  it.live("names a bot-protection challenge instead of reporting an empty catalogue", () =>
    Effect.gen(function* () {
      // Measured against the live console: Bun's fetch is challenged by the bot protection in front
      // of it, so the same key that answers 200 to curl answers 403 here with an HTML interstitial.
      // Reported as "fetch failed", that was indistinguishable from an expired key -- the catalogue
      // fell back to six built-in ids and the only trace was one warning line, which is exactly how
      // a blocked CLI came to look like a short model list.
      const challengeBody =
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
        "<title>Vercel Security Checkpoint</title></head><body></body></html>"
      expect(isBotChallengeBody(challengeBody)).toBe(true)
      // An API error is JSON with a message, so the two are not confusable and a real 403 -- a key
      // without access to something -- is left alone.
      expect(isBotChallengeBody('{"error":{"message":"Forbidden","type":"invalid_request_error"}}')).toBe(false)
      expect(isBotChallengeBody("")).toBe(false)

      const message = new ConsoleBotChallenge(403).message
      // The message has to say the key was fine and name the fix, because the failure looks like an
      // auth problem and is not one.
      expect(message).toContain("bot-protection layer")
      expect(message).toContain("The API key was accepted")
      expect(message).toContain("/api/backend")
      expect(new ConsoleBotChallenge(403).status).toBe(403)
    }),
  )

  it.live("tolerates a listing entry with no vendor blocks at all", () =>
    Effect.gen(function* () {
      // Forward and backward compatibility in one: an entry stripped of `redrob` and `capabilities`
      // must still decode into a usable model rather than failing the parse and dropping the whole
      // catalog to the static fallback.
      const state = yield* Ref.make({
        ...okState(),
        body: JSON.stringify({ object: "list", data: [{ id: "auto", object: "model", created: 1767225600 }] }),
      })
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(Object.keys(result["redrob"].models)).toEqual(["auto"])
      expect(result["redrob"].models["auto"].cost).toEqual({ input: 0, output: 0, tiers: undefined })
      // Still a usable window, so compaction keeps working against a listing that says nothing.
      expect(result["redrob"].models["auto"].limit).toEqual({ context: 1_000_000, output: 32_000 })
    }),
  )

  it.live("the no-key fallback carries a usable context window for every model", () =>
    Effect.gen(function* () {
      delete process.env["REDROB_API_KEY"]
      const state = yield* Ref.make(okState())
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      for (const id of CONSOLE_MODEL_IDS) {
        const model = result["redrob"].models[id]
        // Non-zero context is the whole point offline: at 0, `usable()` returns 0 and `isOverflow()`
        // returns false, so a long session runs into the provider's limit instead of compacting.
        expect(model.limit.context).toBe(1_000_000)
        expect(model.limit.output).toBe(32_000)
        // No key means no authoritative rate. Reporting a stale hardcoded price would be worse than
        // reporting none, so cost stays 0 until the listing supplies it.
        expect(model.cost).toEqual({ input: 0, output: 0 })
      }
      // Reasoning support does not depend on the network, so the offline catalog agrees with the
      // live one on which ids think. `auto` is one of them: the router publishes the full
      // low..max range, and claiming otherwise offline would hide its thinking control.
      expect(result["redrob"].models["claude-opus-5"].reasoning).toBe(true)
      expect(result["redrob"].models["auto"].reasoning).toBe(true)
      // Offline there is no listing, so no LEVELS are known and no variant may be synthesised --
      // an effort the console might reject is worse than none offered.
      expect(result["redrob"].models["auto"].reasoning_options).toEqual([])
      expect(result["redrob"].models["claude-opus-5"].reasoning_options).toEqual([])
      expect(yield* Ref.get(state).pipe(Effect.map((s) => s.calls))).toEqual([])
    }),
  )
})
