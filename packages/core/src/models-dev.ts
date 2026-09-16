import { Context, Duration, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ModelsDev } from "@redrob-code/schema/models-dev"
import { Flag } from "./flag/flag"
import { InstallationChannel, InstallationVersion } from "./installation/version"
import { Credential } from "./credential"
import { EventV2 } from "./event"
import { Integration } from "./integration"
import { makeGlobalNode } from "./effect/app-node"
import { httpClient } from "./effect/app-node-platform"
import {
  CONSOLE_CONTEXT_TOKENS,
  CONSOLE_MODEL,
  CONSOLE_MODELS,
  CONSOLE_OUTPUT_TOKENS,
  CONSOLE_PACKAGE,
  CONSOLE_URL,
  type ConsoleModelInfo,
} from "./plugin/provider/redrob-constants"

export const CatalogModelStatus = Schema.Literals(["alpha", "beta", "deprecated"])
export type CatalogModelStatus = typeof CatalogModelStatus.Type

const InterleavedField = Schema.Union([
  Schema.Literals(["reasoning", "reasoning_content", "reasoning_text"]),
  Schema.String,
])

const USER_AGENT = `redrob/${InstallationChannel}/${InstallationVersion}/${Flag.REDROB_CLIENT}`

const CostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const Cost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tiers: Schema.optional(Schema.Array(CostTier)),
  context_over_200k: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
    }),
  ),
})

const ReasoningOption = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("effort"),
    values: Schema.Array(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("toggle"),
  }),
  Schema.Struct({
    type: Schema.Literal("budget_tokens"),
    min: Schema.optional(Schema.Finite),
    max: Schema.optional(Schema.Finite),
  }),
])

export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  release_date: Schema.String,
  attachment: Schema.Boolean,
  reasoning: Schema.Boolean,
  temperature: Schema.Boolean,
  tool_call: Schema.Boolean,
  reasoning_options: Schema.optional(Schema.Array(ReasoningOption)),
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Boolean,
      InterleavedField,
      Schema.Struct({
        field: InterleavedField,
      }),
    ]),
  ),
  cost: Schema.optional(Cost),
  limit: Schema.Struct({
    context: Schema.Finite,
    input: Schema.optional(Schema.Finite),
    output: Schema.Finite,
  }),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
      output: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      modes: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            cost: Schema.optional(Cost),
            provider: Schema.optional(
              Schema.Struct({
                body: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
                headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
  status: Schema.optional(CatalogModelStatus),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
})
export type Model = Schema.Schema.Type<typeof Model>

export const Provider = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.String,
  env: Schema.Array(Schema.String),
  id: Schema.String,
  npm: Schema.optional(Schema.String),
  models: Schema.Record(Schema.String, Model),
})

export type Provider = Schema.Schema.Type<typeof Provider>

export const Event = ModelsDev.Event

// OpenAI has no field for price or context window, so the console hangs both off vendor keys of its
// own on each listing entry: `redrob` for the published per-million-token rates and `capabilities`
// for the context window plus the thinking/fast/data-share switches. Both are optional so a listing
// that omits them still decodes and falls back to the shared defaults.
const ConsoleModelPrice = Schema.Struct({
  inputPricePerMillionUsd: Schema.Finite,
  outputPricePerMillionUsd: Schema.Finite,
  // Present only on models with a separate usage tier above `capabilities.shortContextTokens`.
  longContextInputPricePerMillionUsd: Schema.optional(Schema.Finite),
  longContextOutputPricePerMillionUsd: Schema.optional(Schema.Finite),
})

const ConsoleModelCapabilities = Schema.Struct({
  // The token count above which the long-context rates apply, not an input cap.
  shortContextTokens: Schema.Finite,
  maxContextTokens: Schema.Finite,
  // The console's own set is low/medium/high/max; decoded as plain strings so a new level does not
  // fail the parse and drop the whole catalog.
  thinkingLevels: Schema.Array(Schema.String),
  // `fastMode` and `requiresProviderDataShare` are request switches on the console's chat endpoint
  // with no counterpart in this schema, so they are decoded to pin the shape and left unprojected.
  fastMode: Schema.Boolean,
  requiresProviderDataShare: Schema.Boolean,
})

// Assumed OpenAI-standard /v1/models listing shape returned by the console endpoint:
//   { "object": "list", "data": [ { "id": "auto", "object": "model", "created": 0, ... } ] }
// Only `data[].id` is required for the catalog; other fields are optional and ignored so
// the parse tolerates the endpoint adding metadata. `created` (seconds since epoch, when
// present) seeds the model release date.
const ConsoleModel = Schema.Struct({
  id: Schema.String,
  object: Schema.optional(Schema.String),
  created: Schema.optional(Schema.Finite),
  redrob: Schema.optional(ConsoleModelPrice),
  capabilities: Schema.optional(ConsoleModelCapabilities),
})

const ConsoleModelList = Schema.Struct({
  object: Schema.optional(Schema.String),
  data: Schema.Array(ConsoleModel),
})

// The console gateway is text-in/text-out: its chat endpoint accepts a string or an array of text
// parts and nothing else, so there is no attachment to send and no modality beyond text to
// advertise. Shared by the fallback and the live projection so the two cannot disagree.
const CONSOLE_MODALITIES = { input: ["text"], output: ["text"] } as const satisfies Model["modalities"]

// The console's thinking control is a top-level `thinking` level on its chat endpoint, not OpenAI's
// `reasoning_effort`, and that endpoint rejects fields it does not whitelist. An empty option list
// is how ProviderTransform is told to publish no effort variants: `reasoningVariants` returns `{}`
// for it, which stops `variants()` from synthesising `reasoningEffort` variants the console would
// refuse with a 400.
const CONSOLE_REASONING_OPTIONS = [] as const satisfies Model["reasoning_options"]

// The static fallback catalog: mirrors the values RedrobPlugin registers into the V2 catalog so
// `redrob models` always lists every served console model (CONSOLE_MODELS) even with no key or a
// failed fetch. Limits come from the verified `capabilities` block so auto-compaction still works
// offline. Cost stays 0 with no key: the live listing is the only authoritative source of a rate,
// and reporting a stale hardcoded price is worse than reporting none.
const redrobFallbackModel = (model: ConsoleModelInfo): Model => ({
  id: model.id,
  name: model.name,
  release_date: "",
  attachment: false,
  reasoning: model.thinking,
  reasoning_options: CONSOLE_REASONING_OPTIONS,
  temperature: true,
  tool_call: true,
  cost: { input: 0, output: 0 },
  limit: { context: CONSOLE_CONTEXT_TOKENS, output: CONSOLE_OUTPUT_TOKENS },
  modalities: CONSOLE_MODALITIES,
  // No status: the schema status set is alpha/beta/deprecated; ModelsDevPlugin defaults an
  // absent status to "active" when projecting into the V2 catalog.
  provider: { npm: CONSOLE_PACKAGE, api: CONSOLE_URL },
})

const redrobProvider = (models: Record<string, Model>): Provider => ({
  id: "redrob",
  name: "Redrob",
  env: ["REDROB_API_KEY"],
  npm: CONSOLE_PACKAGE,
  api: CONSOLE_URL,
  models,
})

const fallbackCatalog = (): Record<string, Provider> => ({
  redrob: redrobProvider(Object.fromEntries(CONSOLE_MODELS.map((model) => [model.id, redrobFallbackModel(model)]))),
})

// Project one console /models entry into the internal ModelsDev.Model shape, reading the vendor
// `redrob` and `capabilities` blocks for the values OpenAI's listing shape has no field for. Every
// model is a text-in/text-out tool-calling model served by @ai-sdk/openai-compatible against
// CONSOLE_URL.
const consoleModel = (model: Schema.Schema.Type<typeof ConsoleModel>): Model => ({
  id: model.id,
  name: model.id,
  release_date: model.created ? new Date(model.created * 1000).toISOString().slice(0, 10) : "",
  attachment: false,
  // Published thinking levels are what makes a model a reasoning model here; an empty list means
  // the console serves it without any thinking control.
  reasoning: (model.capabilities?.thinkingLevels.length ?? 0) > 0,
  reasoning_options: CONSOLE_REASONING_OPTIONS,
  temperature: true,
  tool_call: true,
  cost: consoleCost(model),
  limit: {
    // maxContextTokens is the whole window. There is no published input cap, so limit.input stays
    // absent and `usable()` reserves the reply out of the window instead.
    context: model.capabilities?.maxContextTokens ?? CONSOLE_CONTEXT_TOKENS,
    output: CONSOLE_OUTPUT_TOKENS,
  },
  modalities: CONSOLE_MODALITIES,
  provider: { npm: CONSOLE_PACKAGE, api: CONSOLE_URL },
})

// The console quotes USD per million tokens, which is the unit `cost` already carries. A model with
// a separate long-context card becomes a context tier keyed to `shortContextTokens`, the threshold
// the higher rates start at — the same shape ModelsDevPlugin already projects `context_over_200k`
// into. Both long-context rates have to be present to price a tier, so one without the other is
// ignored rather than half-applied.
const consoleCost = (model: Schema.Schema.Type<typeof ConsoleModel>): Model["cost"] => {
  const price = model.redrob
  if (!price) return { input: 0, output: 0 }
  const longInput = price.longContextInputPricePerMillionUsd
  const longOutput = price.longContextOutputPricePerMillionUsd
  const threshold = model.capabilities?.shortContextTokens
  return {
    input: price.inputPricePerMillionUsd,
    output: price.outputPricePerMillionUsd,
    tiers:
      longInput !== undefined && longOutput !== undefined && threshold !== undefined
        ? [{ input: longInput, output: longOutput, tier: { type: "context", size: threshold } }]
        : undefined,
  }
}

export interface Interface {
  readonly get: () => Effect.Effect<Record<string, Provider>>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@redrob/ModelsDev") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const credential = yield* Credential.Service
    // filterStatusOk turns any non-2xx response (e.g. the 401 returned without a valid key)
    // into an HttpClientError so populate's orElseSucceed can degrade to the static fallback.
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)

    // Fetch the OpenAI-standard model listing from the real console endpoint
    // (GET https://console.redrob.ai/api/backend/v1/models) authenticated with the caller's
    // REDROB_API_KEY. The fetch is best-effort and non-fatal: when the key is absent, the flag
    // disables the network call, or the request fails (401/402/timeout/network/parse), populate
    // degrades to the static console fallback catalog and logs a warning rather than
    // crashing the CLI. The endpoint returns 401 without a valid key, which is an expected and
    // acceptable outcome that must degrade gracefully.
    const fetchModels = Effect.fn("ModelsDev.fetchModels")(function* (apiKey: string) {
      const response = yield* HttpClientRequest.get(`${CONSOLE_URL}/models`).pipe(
        HttpClientRequest.setHeader("User-Agent", USER_AGENT),
        HttpClientRequest.bearerToken(apiKey),
        http.execute,
        Effect.flatMap((res) => res.text),
        Effect.timeout("10 seconds"),
      )
      const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(ConsoleModelList))(response)
      if (decoded._tag === "None") return yield* Effect.fail(new Error("Failed to parse console /models response"))
      const models: Record<string, Model> = {}
      for (const model of decoded.value.data) models[model.id] = consoleModel(model)
      // Always guarantee the primary `auto` model lists even if the endpoint omits it. Only the
      // primary is backfilled: with a key the listing is authoritative, so a model it stops
      // advertising must not be resurrected from the static list.
      if (!models[CONSOLE_MODEL.id]) models[CONSOLE_MODEL.id] = redrobFallbackModel(CONSOLE_MODEL)
      return { redrob: redrobProvider(models) } as Record<string, Provider>
    })

    // The console key reaches us two ways: exported as REDROB_API_KEY, or stored on the
    // redrob integration by `redrob providers login`. Only reading the environment made the
    // dynamic catalog silently fall back to the static list for anyone who logged in through
    // the CLI, so check the credential store too.
    const resolveApiKey = Effect.fn("ModelsDev.resolveApiKey")(function* () {
      const fromEnv = process.env["REDROB_API_KEY"]
      if (fromEnv) return fromEnv
      const stored = yield* credential.list(Integration.ID.make("redrob"))
      return stored.flatMap((item) => (item.value.type === "key" ? [item.value.key] : []))[0]
    })

    const populate = Effect.gen(function* () {
      // Test-only seam: when REDROB_MODELS_FIXTURE points at a catalog JSON file, load it and
      // skip the network entirely. This lets the offline test suites drive the V1 provider
      // transform against a realistic multi-provider catalog without reaching the console. It is
      // never set in production and is intentionally separate from the console /models fetch.
      const fixturePath = process.env["REDROB_MODELS_FIXTURE"]
      if (fixturePath) {
        const fromFixture = yield* Effect.tryPromise(() => Bun.file(fixturePath).json()).pipe(
          Effect.map((value) => value as Record<string, Provider>),
          Effect.orElseSucceed(fallbackCatalog),
        )
        return fromFixture
      }
      const apiKey = yield* resolveApiKey()
      if (Flag.REDROB_DISABLE_MODELS_FETCH || !apiKey) return fallbackCatalog()
      return yield* fetchModels(apiKey).pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("ModelsDev console /models fetch failed; using static fallback", { cause }),
        ),
        Effect.orElseSucceed(fallbackCatalog),
      )
    }).pipe(Effect.withSpan("ModelsDev.populate"))

    const [cachedGet, invalidate] = yield* Effect.cachedInvalidateWithTTL(populate, Duration.infinity)

    const get = (): Effect.Effect<Record<string, Provider>> => cachedGet

    const refresh = Effect.fn("ModelsDev.refresh")(function* (_force = false) {
      // Skip the invalidate + publish when a real console fetch is impossible (the flag disables
      // it or no key is set): populate would just re-return the same static fallback, so
      // reprojecting the V2 catalog is wasted work. `force` is accepted for API compatibility.
      if (Flag.REDROB_DISABLE_MODELS_FETCH) return
      if (!(yield* resolveApiKey())) return
      // Invalidate the in-memory cache so the next get() re-fetches /models, then notify
      // ModelsDevPlugin so it reprojects the V2 catalog.
      yield* invalidate
      yield* events.publish(Event.Refreshed, {})
    })

    return Service.of({ get, refresh })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: () => [EventV2.node, Credential.node, httpClient],
})

export * as ModelsDev from "./models-dev"
