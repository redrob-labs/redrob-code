import { Context, Duration, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ModelsDev } from "@redrob-code/schema/models-dev"
import { join } from "path"
import { Global } from "./global"
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
  // The console's own set is low/medium/high/xhigh/max; decoded as plain strings so a new level does
  // not fail the parse and drop the whole catalog.
  thinkingLevels: Schema.Array(Schema.String),
  // `fastMode` and `requiresProviderDataShare` are request switches on the console's chat endpoint
  // with no counterpart in this schema, so they are decoded to pin the shape and left unprojected.
  fastMode: Schema.Boolean,
  requiresProviderDataShare: Schema.Boolean,
  // What the model accepts and returns beyond text. The console publishes these per model -- 177 of
  // its models take an image -- and its chat endpoint accepts an `image_url` content part, so these
  // are the flags that decide whether an attachment can be sent at all. Optional because a listing
  // written before they existed must still decode.
  imageInput: Schema.optional(Schema.Boolean),
  audioInput: Schema.optional(Schema.Boolean),
  fileInput: Schema.optional(Schema.Boolean),
  videoInput: Schema.optional(Schema.Boolean),
  imageOutput: Schema.optional(Schema.Boolean),
  audioOutput: Schema.optional(Schema.Boolean),
  // The published reply cap, where CONSOLE_OUTPUT_TOKENS is only this CLI's own request ceiling.
  // Nullable, not merely absent: the console publishes an explicit `null` for the models it has no
  // cap for (7 of its 323 at the time of writing). Declared `number | undefined`, that one null
  // failed the whole-array decode and took all 323 models down with it, which is what left the
  // catalog showing six built-in ids.
  maxOutputTokens: Schema.optional(Schema.NullOr(Schema.Finite)),
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
  // Entries stay `unknown` here and are decoded one at a time below. Decoding the array as a whole
  // is all-or-nothing: a single unexpected value anywhere in 323 entries rejects the entire listing
  // and the catalog silently becomes the six-id fallback. One model this CLI cannot describe should
  // cost that one model, not the catalog -- the same reason `thinkingLevels` is decoded as plain
  // strings a few lines up.
  data: Schema.Array(Schema.Unknown),
})

// The console's chat endpoint accepts `image_url` and `input_audio` content parts, and publishes per
// model which of them that model can actually read. So modalities are read from the listing rather
// than asserted here.
//
// This used to be hardcoded to text-in/text-out, on the belief that the gateway took nothing but
// text. That belief was the reason an attachment never reached a model: ProviderTransform consults
// `capabilities.input[modality]` and, finding image false, replaces the image with the text
// `ERROR: Cannot read image (this model does not support image input)`. The flags below are what
// stop that happening for the 177 models that do take one.
//
// Text is always in the input set: every console model reads text, and a listing that omitted the
// flags entirely must still describe a usable model.
const TEXT_ONLY_MODALITIES = { input: ["text"], output: ["text"] } as const satisfies Model["modalities"]

const consoleAttachment = (
  capabilities: Schema.Schema.Type<typeof ConsoleModelCapabilities> | undefined,
): boolean =>
  Boolean(
    capabilities?.imageInput || capabilities?.audioInput || capabilities?.fileInput || capabilities?.videoInput,
  )

const consoleModalities = (
  capabilities: Schema.Schema.Type<typeof ConsoleModelCapabilities> | undefined,
): Model["modalities"] => {
  if (!capabilities) return TEXT_ONLY_MODALITIES
  const input: NonNullable<Model["modalities"]>["input"][number][] = ["text"]
  if (capabilities.imageInput) input.push("image")
  if (capabilities.audioInput) input.push("audio")
  if (capabilities.videoInput) input.push("video")
  // `fileInput` has no modality of its own in this schema: a PDF arrives as a file part and is
  // gated by the mime-to-modality mapping, so there is nothing to advertise for it here.
  const output: NonNullable<Model["modalities"]>["output"][number][] = ["text"]
  if (capabilities.imageOutput) output.push("image")
  if (capabilities.audioOutput) output.push("audio")
  return { input, output }
}

// The console's thinking control is a top-level `thinking` level on its chat endpoint, not OpenAI's
// `reasoning_effort`, and that endpoint rejects fields it does not whitelist. So the effort values
// come from the listing's own `capabilities.thinkingLevels` and ProviderTransform maps the chosen
// one onto `thinking` for this provider — see the `redrob` case in `reasoningEffort`, which is what
// keeps `reasoning_effort` off the wire.
//
// An empty list still means "publish no variants": `reasoningVariants` returns `{}` for it, which
// stops `variants()` from synthesising efforts a model does not offer.
const CONSOLE_REASONING_OPTIONS = [] as const satisfies Model["reasoning_options"]

/**
 * Effort variants for one console model, from the levels it publishes.
 *
 * Verbatim: the console validates `thinking` against its own enum
 * (low | medium | high | xhigh | max), so a level is passed through as published rather than mapped
 * onto OpenAI's three-value effort scale, which would lose `xhigh` and `max` entirely.
 */
const consoleReasoningOptions = (
  capabilities: Schema.Schema.Type<typeof ConsoleModelCapabilities> | undefined,
): Model["reasoning_options"] => {
  const levels = capabilities?.thinkingLevels ?? []
  if (levels.length === 0) return CONSOLE_REASONING_OPTIONS
  return [{ type: "effort", values: [...levels] }]
}

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
  // Text only, deliberately: with no key there is no listing, and claiming an attachment the
  // model may not read would produce a failed request instead of an unavailable button. The live
  // listing is what turns image input on.
  modalities: TEXT_ONLY_MODALITIES,
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
  // `attachment` is what a client reads to decide whether to offer a file button at all, so it has
  // to agree with the modalities below rather than stay false while they say an image is fine.
  attachment: consoleAttachment(model.capabilities),
  // Published thinking levels are what makes a model a reasoning model here; an empty list means
  // the console serves it without any thinking control.
  reasoning: (model.capabilities?.thinkingLevels.length ?? 0) > 0,
  reasoning_options: consoleReasoningOptions(model.capabilities),
  temperature: true,
  tool_call: true,
  cost: consoleCost(model),
  limit: {
    // maxContextTokens is the whole window. There is no published input cap, so limit.input stays
    // absent and `usable()` reserves the reply out of the window instead.
    context: model.capabilities?.maxContextTokens ?? CONSOLE_CONTEXT_TOKENS,
    // The published reply cap when there is one; this CLI's own ceiling otherwise.
    output: model.capabilities?.maxOutputTokens ?? CONSOLE_OUTPUT_TOKENS,
  },
  modalities: consoleModalities(model.capabilities),
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

/**
 * A bot-protection challenge standing between this CLI and the console.
 *
 * The console is fronted by Vercel, whose bot protection answers a request it does not recognise as
 * a browser with `403` and an HTML interstitial. This CLI is compiled with Bun, and Bun's fetch is
 * one of the clients that gets challenged: the same key and the same URL answer `200` to curl and
 * `403` here, whatever headers are sent. There is no header to add and no retry that helps -- the
 * challenge wants a browser to solve it, and there is no browser.
 *
 * Named so it does not read as "no models available". Without this, the failure was indistinguishable
 * from an expired key: the catalogue quietly fell back to six built-in ids and the only trace was one
 * log line, so a user saw a short model list and no reason for it.
 */
export class ConsoleBotChallenge extends Error {
  readonly _tag = "ConsoleBotChallenge"
  constructor(readonly status: number) {
    super(
      `The console refused this request with ${status} at its bot-protection layer, not at authentication. ` +
        `The API key was accepted; the request never reached the API. ` +
        `Allow this CLI through: in the console project's Vercel dashboard, add a Firewall bypass rule for ` +
        `the /api/backend/* path (Firewall > Configure > New Rule > path starts with /api/backend > Bypass), ` +
        `or exclude that path from the Bot Protection managed ruleset. Until then the model list falls back ` +
        `to the built-in ids and chat requests fail the same way.`,
    )
  }
}

/**
 * Whether a 4xx body is a bot-protection interstitial rather than an API error.
 *
 * Matched on the challenge's own markers. An API error is JSON with a message; this is an HTML page
 * whose title says what it is, so the two are not confusable and a real 403 from the API -- a key
 * without access to a model, say -- is left alone.
 */
export function isBotChallengeBody(body: string): boolean {
  const head = body.slice(0, 4000)
  if (!/^\s*</.test(head)) return false
  return (
    /Vercel Security Checkpoint/i.test(head) ||
    /security checkpoint/i.test(head) ||
    /_vercel\/challenge/i.test(head) ||
    /cf-challenge|__cf_chl/i.test(head)
  )
}

/**
 * The console key as `PUT /auth/redrob` leaves it, read straight from `auth.json`.
 *
 * The Auth service that owns this file lives in the `redrob` package, which depends on this one, so it
 * cannot be imported here. Reading the file is the whole of that service's behaviour for this case, and
 * the alternative - a callback the server has to remember to wire - fails silently in exactly the way
 * this bug already failed once.
 *
 * Deliberately forgiving: a missing file, unreadable JSON, an entry of some other `type`, or a blank key
 * all mean "no key here", not an error. The catalogue's keyless branch is a legitimate state, and the
 * only thing this must never do is turn a readable key into a crash.
 */
function authStoreApiKey(): Effect.Effect<string | undefined> {
  return Effect.tryPromise(() => Bun.file(join(Global.Path.data, "auth.json")).json()).pipe(
    Effect.map((data) => {
      if (typeof data !== "object" || data === null) return undefined
      const entry = (data as Record<string, unknown>)["redrob"]
      if (typeof entry !== "object" || entry === null) return undefined
      const record = entry as Record<string, unknown>
      // auth.json spells an api key `type: "api"`, where the Credential store spells it `type: "key"`.
      if (record["type"] !== "api") return undefined
      const key = record["key"]
      return typeof key === "string" && key.trim() ? key : undefined
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

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
      const request = HttpClientRequest.get(`${CONSOLE_URL}/models`).pipe(
        HttpClientRequest.setHeader("User-Agent", USER_AGENT),
        HttpClientRequest.bearerToken(apiKey),
      )
      // The body is read even on a non-2xx, because a bot-protection challenge and an API error
      // arrive with the same status and are told apart only by what they contain. So the response is
      // taken raw and the status checked here, rather than letting a 4xx fail the effect before the
      // body exists.
      const res = yield* http.execute(request).pipe(Effect.timeout("10 seconds"))
      const body = yield* res.text
      if (res.status === 403 || res.status === 401) {
        if (isBotChallengeBody(body)) return yield* Effect.fail(new ConsoleBotChallenge(res.status))
        return yield* Effect.fail(new Error(`console /models refused the request with ${res.status}`))
      }
      if (res.status < 200 || res.status >= 300) {
        return yield* Effect.fail(new Error(`console /models returned ${res.status}`))
      }
      const response = body
      const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(ConsoleModelList))(response)
      if (decoded._tag === "None") return yield* Effect.fail(new Error("Failed to parse console /models response"))
      const models: Record<string, Model> = {}
      let rejected = 0
      for (const entry of decoded.value.data) {
        const model = Schema.decodeUnknownOption(ConsoleModel)(entry)
        if (model._tag === "None") {
          rejected++
          continue
        }
        models[model.value.id] = consoleModel(model.value)
      }
      // Silence here is what hid the previous failure, so a dropped entry is reported. It is a warning
      // rather than an error: the catalog is usable, just short by however many entries this CLI could
      // not describe.
      if (rejected > 0)
        yield* Effect.logWarning(
          `ModelsDev: dropped ${rejected} of ${decoded.value.data.length} console models this build cannot describe`,
        )
      if (Object.keys(models).length === 0)
        return yield* Effect.fail(new Error("console /models returned no model this build can describe"))
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
    /**
     * The console key, from wherever the user actually put it.
     *
     * Three origins, and they are not interchangeable historically. `REDROB_API_KEY` is the one a
     * terminal user exports. The Credential store is what `redrob providers login` writes. And
     * `auth.json` is what `PUT /auth/redrob` writes, which is the route the DESKTOP APP uses for both
     * of its connect paths, the pasted key and "Connect Redrob" - that flow ends by handing the key to
     * this same route, so the app never populates the Credential store at all.
     *
     * Reading only the first two is why a user who connected through the app saw six models: the key
     * was present, in auth.json, and the catalogue could not see it, so `populate` took the keyless
     * branch and returned the built-in list. Nothing bridges the two stores - the Credential store is
     * SQL, auth.json is a file, and no migration copies one into the other - so the catalogue has to
     * read both.
     *
     * Note the shapes differ as well as the locations: the Credential store discriminates on
     * `type: "key"`, auth.json on `type: "api"`. Matching only one of those spellings was the second
     * half of the same bug.
     */
    const resolveApiKey = Effect.fn("ModelsDev.resolveApiKey")(function* () {
      const fromEnv = process.env["REDROB_API_KEY"]
      if (fromEnv) return fromEnv
      const stored = yield* credential.list(Integration.ID.make("redrob"))
      const fromCredential = stored.flatMap((item) => (item.value.type === "key" ? [item.value.key] : []))[0]
      if (fromCredential) return fromCredential
      return yield* authStoreApiKey()
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
          // A bot challenge is not the same event as a bad key or a timeout, and reporting it as
          // "fetch failed" is what made a blocked CLI look like an empty catalogue. The named error
          // carries what to do about it, so it is logged at error level and its own message is used.
          String(cause).includes("ConsoleBotChallenge")
            ? Effect.logError(`ModelsDev: ${String(cause)}`)
            : Effect.logWarning("ModelsDev console /models fetch failed; using static fallback", { cause }),
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
