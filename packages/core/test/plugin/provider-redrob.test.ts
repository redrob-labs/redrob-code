import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Catalog } from "@redrob-code/core/catalog"
import { EventV2 } from "@redrob-code/core/event"
import { Integration } from "@redrob-code/core/integration"
import { ModelV2 } from "@redrob-code/core/model"
import { PluginV2 } from "@redrob-code/core/plugin"
import { PluginHost } from "@redrob-code/core/plugin/host"
import { RedrobPlugin } from "@redrob-code/core/plugin/provider/redrob"
import { ProviderV2 } from "@redrob-code/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const CONSOLE_URL = "https://console.redrob.ai/api/backend/v1"
const CONSOLE_PACKAGE = "@ai-sdk/openai-compatible"
const MODEL_ID = ModelV2.ID.make("auto")
// The console /models listing (verified live) serves six ids; `redrob-ai` and `redrob-translate` are
// retired and no longer valid model ids. The static V2 registration must register every served id.
const SERVED_MODELS = [
  ["auto", "Redrob Auto"],
  ["gpt-5.6-sol", "GPT-5.6 Sol"],
  ["gpt-5.6-terra", "GPT-5.6 Terra"],
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-fable-5", "Claude Fable 5"],
]
const OPUS_MODEL_ID = ModelV2.ID.make("claude-opus-5")

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  const events = yield* EventV2.Service
  const integration = yield* Integration.Service
  yield* RedrobPlugin.effect(host).pipe(
    Effect.provideService(EventV2.Service, events),
    Effect.provideService(Integration.Service, integration),
  )
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function withEnv<A, E, R>(vars: Record<string, string | undefined>, effect: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    effect,
    (previous) =>
      Effect.sync(() =>
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }),
      ),
  )
}

const cost = (input: number, output = 0) => [{ input, output, cache: { read: 0, write: 0 } }]

describe("RedrobPlugin", () => {
  it.effect("registers only the api-key method", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      expect((yield* (yield* Integration.Service).get(Integration.ID.make("redrob")))?.methods).toEqual([
        { type: "key", label: "Redrob API key" },
      ])
    }),
  )

  it.effect("statically registers the console provider and every console model", () =>
    withEnv({ REDROB_API_KEY: "secret" }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* addPlugin()

        const provider = required(yield* catalog.provider.get(ProviderV2.ID.redrob))
        expect(provider.integrationID).toBe(Integration.ID.make("redrob"))
        expect(provider.api).toMatchObject({
          type: "aisdk",
          package: CONSOLE_PACKAGE,
          url: CONSOLE_URL,
        })

        const model = required(yield* catalog.model.get(ProviderV2.ID.redrob, MODEL_ID))
        expect(model.name).toBe("Redrob Auto")
        expect(model.api).toMatchObject({
          id: MODEL_ID,
          type: "aisdk",
          package: CONSOLE_PACKAGE,
          url: CONSOLE_URL,
        })
        expect(model.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] })
        expect(model.enabled).toBe(true)

        // Every served console id registers, and the legacy aliases do not.
        for (const [id, name] of SERVED_MODELS) {
          const served = required(yield* catalog.model.get(ProviderV2.ID.redrob, ModelV2.ID.make(id)))
          expect(served.name).toBe(name)
          expect(served.api).toMatchObject({
            id: ModelV2.ID.make(id),
            type: "aisdk",
            package: CONSOLE_PACKAGE,
            url: CONSOLE_URL,
          })
          expect(served.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] })
          expect(served.enabled).toBe(true)
        }
        expect(yield* catalog.model.get(ProviderV2.ID.redrob, ModelV2.ID.make("redrob-ai"))).toBeUndefined()
        expect(yield* catalog.model.get(ProviderV2.ID.redrob, ModelV2.ID.make("redrob-translate"))).toBeUndefined()
      }),
    ),
  )

  // The plugin used to disable every redrob model priced above 0 when no credential was present, a
  // rule inherited from providers that mix free and paid models. The console has no free tier — one
  // key gates all six ids — so a price says nothing about whether a model should be listed, and now
  // that ModelsDevPlugin projects the listing's real per-million rates that rule would have emptied
  // the catalog for every keyless user. Only the placeholder api key is applied now.
  it.effect("uses a public key and still lists priced models without credentials", () =>
    withEnv({ REDROB_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* catalog.transform((catalog) => {
          const provider = ProviderV2.Info.make({
            ...ProviderV2.Info.empty(ProviderV2.ID.redrob),
            api: { type: "aisdk", package: "test-provider" },
          })
          const model = ModelV2.Info.make({
            ...ModelV2.Info.empty(provider.id, ModelV2.ID.make("paid")),
            api: { id: ModelV2.ID.make("paid"), type: "aisdk", package: "test-provider" },
            cost: cost(1),
          })
          catalog.provider.update(provider.id, () => {})
          catalog.model.update(provider.id, model.id, (draft) => {
            draft.cost = [...model.cost]
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.provider.get(ProviderV2.ID.redrob)).request.body.apiKey).toBe("public")
        expect(required(yield* catalog.model.get(ProviderV2.ID.redrob, ModelV2.ID.make("paid"))).enabled).toBe(true)
      }),
    ),
  )

  // A zero context window is not a neutral default: `usable()` in
  // packages/redrob/src/session/overflow.ts returns 0 and `isOverflow()` returns false whenever
  // limit.context is 0, so the static registration has to carry the real window or auto-compaction
  // never fires for anyone on the offline path.
  it.effect("registers a usable context and output window for every console model", () =>
    withEnv({ REDROB_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* addPlugin()
        for (const [id] of SERVED_MODELS) {
          const model = required(yield* catalog.model.get(ProviderV2.ID.redrob, ModelV2.ID.make(id)))
          expect(model.limit).toEqual({ context: 1_000_000, output: 32_000 })
        }
      }),
    ),
  )

  it.effect("keeps the static console models enabled without credentials", () =>
    withEnv({ REDROB_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* addPlugin()
        expect(required(yield* catalog.provider.get(ProviderV2.ID.redrob)).request.body.apiKey).toBe("public")
        expect(required(yield* catalog.model.get(ProviderV2.ID.redrob, MODEL_ID)).enabled).toBe(true)
        expect(required(yield* catalog.model.get(ProviderV2.ID.redrob, OPUS_MODEL_ID)).enabled).toBe(true)
      }),
    ),
  )

  it.effect("keeps free models without credentials", () =>
    withEnv({ REDROB_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* catalog.transform((catalog) => {
          const provider = ProviderV2.Info.make({
            ...ProviderV2.Info.empty(ProviderV2.ID.redrob),
            api: { type: "aisdk", package: "test-provider" },
          })
          const model = ModelV2.Info.make({
            ...ModelV2.Info.empty(provider.id, ModelV2.ID.make("free")),
            api: { id: ModelV2.ID.make("free"), type: "aisdk", package: "test-provider" },
            cost: cost(0),
          })
          catalog.provider.update(provider.id, () => {})
          catalog.model.update(provider.id, model.id, (draft) => {
            draft.cost = [...model.cost]
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.provider.get(ProviderV2.ID.redrob)).request.body.apiKey).toBe("public")
        expect(required(yield* catalog.model.get(ProviderV2.ID.redrob, ModelV2.ID.make("free"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("treats output-only cost as free without credentials", () =>
    withEnv({ REDROB_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* catalog.transform((catalog) => {
          const provider = ProviderV2.Info.make({
            ...ProviderV2.Info.empty(ProviderV2.ID.redrob),
            api: { type: "aisdk", package: "test-provider" },
          })
          const model = ModelV2.Info.make({
            ...ModelV2.Info.empty(provider.id, ModelV2.ID.make("output-only")),
            api: { id: ModelV2.ID.make("output-only"), type: "aisdk", package: "test-provider" },
            cost: cost(0, 1),
          })
          catalog.provider.update(provider.id, () => {})
          catalog.model.update(provider.id, model.id, (draft) => {
            draft.cost = [...model.cost]
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.provider.get(ProviderV2.ID.redrob)).request.body.apiKey).toBe("public")
        expect(required(yield* catalog.model.get(ProviderV2.ID.redrob, ModelV2.ID.make("output-only"))).enabled).toBe(
          true,
        )
      }),
    ),
  )

  it.effect("uses REDROB_API_KEY as credentials", () =>
    withEnv({ REDROB_API_KEY: "secret" }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* catalog.transform((catalog) => {
          const provider = ProviderV2.Info.make({
            ...ProviderV2.Info.empty(ProviderV2.ID.redrob),
            api: { type: "aisdk", package: "test-provider" },
          })
          const model = ModelV2.Info.make({
            ...ModelV2.Info.empty(provider.id, ModelV2.ID.make("paid")),
            api: { id: ModelV2.ID.make("paid"), type: "aisdk", package: "test-provider" },
            cost: cost(1),
          })
          catalog.provider.update(provider.id, () => {})
          catalog.model.update(provider.id, model.id, (draft) => {
            draft.cost = [...model.cost]
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.provider.get(ProviderV2.ID.redrob)).request.body.apiKey).toBeUndefined()
        expect(required(yield* catalog.model.get(ProviderV2.ID.redrob, ModelV2.ID.make("paid"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("uses configured apiKey as credentials", () =>
    withEnv({ REDROB_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* catalog.transform((catalog) => {
          const provider = ProviderV2.Info.make({
            ...ProviderV2.Info.empty(ProviderV2.ID.redrob),
            api: { type: "aisdk", package: "test-provider" },
            request: {
              headers: {},
              body: { apiKey: "configured" },
            },
          })
          const model = ModelV2.Info.make({
            ...ModelV2.Info.empty(provider.id, ModelV2.ID.make("paid")),
            api: { id: ModelV2.ID.make("paid"), type: "aisdk", package: "test-provider" },
            cost: cost(1),
          })
          catalog.provider.update(provider.id, (draft) => {
            draft.request = provider.request
          })
          catalog.model.update(provider.id, model.id, (draft) => {
            draft.cost = [...model.cost]
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.provider.get(ProviderV2.ID.redrob)).request.body.apiKey).toBe("configured")
        expect(required(yield* catalog.model.get(ProviderV2.ID.redrob, ModelV2.ID.make("paid"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("ignores non-redrob providers and models", () =>
    withEnv({ REDROB_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* catalog.transform((catalog) => {
          const provider = ProviderV2.Info.make({
            ...ProviderV2.Info.empty(ProviderV2.ID.openai),
            api: { type: "aisdk", package: "test-provider" },
          })
          const model = ModelV2.Info.make({
            ...ModelV2.Info.empty(provider.id, ModelV2.ID.make("paid")),
            api: { id: ModelV2.ID.make("paid"), type: "aisdk", package: "test-provider" },
            cost: cost(1),
          })
          catalog.provider.update(provider.id, () => {})
          catalog.model.update(provider.id, model.id, (draft) => {
            draft.cost = [...model.cost]
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.provider.get(ProviderV2.ID.openai)).request.body.apiKey).toBeUndefined()
        expect(required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("paid"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("prefers gpt-5-nano as the redrob small model", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.redrob

      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, () => {})
        catalog.model.update(providerID, ModelV2.ID.make("cheap-mini"), (model) => {
          model.capabilities.input = ["text"]
          model.capabilities.output = ["text"]
          model.cost = [...cost(1, 1)]
          model.time.released = Date.now()
        })
        catalog.model.update(providerID, ModelV2.ID.make("gpt-5-nano"), (model) => {
          model.capabilities.input = ["text"]
          model.capabilities.output = ["text"]
          model.cost = [...cost(10, 10)]
          model.time.released = Date.now()
        })
      })

      const selected = yield* catalog.model.small(providerID)

      expect(selected?.id).toBe(ModelV2.ID.make("gpt-5-nano"))
    }),
  )
})
