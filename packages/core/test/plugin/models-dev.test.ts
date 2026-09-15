import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Catalog } from "@redrob-code/core/catalog"
import { Integration } from "@redrob-code/core/integration"
import { AppNodeBuilder } from "@redrob-code/core/effect/app-node-builder"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { EventV2 } from "@redrob-code/core/event"
import { Location } from "@redrob-code/core/location"
import { ModelV2 } from "@redrob-code/core/model"
import { ModelsDev } from "@redrob-code/core/models-dev"
import { ModelsDevPlugin } from "@redrob-code/core/plugin/models-dev"
import { ProviderV2 } from "@redrob-code/core/provider"
import { AbsolutePath } from "@redrob-code/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { catalogHost, host, integrationHost } from "./host"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const layer = AppNodeBuilder.build(LayerNode.group([Catalog.node, Integration.node, EventV2.node]), [
  [Location.node, locationLayer],
])
const it = testEffect(layer)

describe("ModelsDevPlugin", () => {
  it.effect("projects models.dev modes as separate models instead of variants", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      const models = ModelsDev.Service.of({
        get: () =>
          Effect.succeed({
            redrob: {
              id: "redrob",
              name: "Acme",
              env: [],
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.acme.test/v1",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  family: "gpt",
                  release_date: "2026-01-01",
                  attachment: false,
                  reasoning: true,
                  temperature: true,
                  tool_call: true,
                  cost: {
                    input: 2.5,
                    output: 15,
                    tiers: [
                      {
                        tier: { type: "context", size: 272_000 },
                        input: 3,
                        output: 18,
                        cache_read: 0.25,
                      },
                    ],
                    context_over_200k: { input: 5, output: 22.5, cache_read: 0.5 },
                  },
                  limit: { context: 1_050_000, input: 922_000, output: 128_000 },
                  experimental: {
                    modes: {
                      fast: {
                        cost: { input: 5, output: 30, cache_read: 0.5 },
                        provider: {
                          headers: { "x-mode": "fast" },
                          body: { service_tier: "priority" },
                        },
                      },
                    },
                  },
                },
              },
            },
          } satisfies Record<string, ModelsDev.Provider>),
        refresh: () => Effect.void,
      })

      yield* ModelsDevPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      ).pipe(Effect.provideService(ModelsDev.Service, models))

      const providerID = ProviderV2.ID.make("redrob")
      const base = yield* catalog.model.get(providerID, ModelV2.ID.make("gpt-5.4"))
      const fast = yield* catalog.model.get(providerID, ModelV2.ID.make("gpt-5.4-fast"))

      expect(base?.variants).toEqual([])
      expect(base?.request.body).toEqual({})
      expect(fast).toMatchObject({
        id: "gpt-5.4-fast",
        providerID: "redrob",
        name: "GPT-5.4 Fast",
        api: { id: "gpt-5.4" },
        request: {
          headers: { "x-mode": "fast" },
          body: { service_tier: "priority" },
        },
        variants: [],
      })
      expect(fast?.cost).toEqual([
        { input: 5, output: 30, cache: { read: 0.5, write: 0 } },
        {
          tier: { type: "context", size: 272_000 },
          input: 3,
          output: 18,
          cache: { read: 0.25, write: 0 },
        },
        {
          tier: { type: "context", size: 200_000 },
          input: 5,
          output: 22.5,
          cache: { read: 0.5, write: 0 },
        },
      ])
    }),
  )

  it.effect("excludes providers that are not in the allowlist from catalog and integrations", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      const models = ModelsDev.Service.of({
        get: () =>
          Effect.succeed({
            // Allowlisted console provider — must be kept.
            redrob: {
              id: "redrob",
              name: "Acme",
              env: ["ACME_API_KEY"],
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.acme.test/v1",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  family: "gpt",
                  release_date: "2026-01-01",
                  attachment: false,
                  reasoning: true,
                  temperature: true,
                  tool_call: true,
                  cost: { input: 2.5, output: 15 },
                  limit: { context: 1_050_000, input: 922_000, output: 128_000 },
                },
              },
            },
            // NON-allowlisted third-party provider — must be filtered out entirely.
            evilcorp: {
              id: "evilcorp",
              name: "EvilCorp",
              env: ["EVILCORP_API_KEY"],
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.evilcorp.test/v1",
              models: {
                "evil-1": {
                  id: "evil-1",
                  name: "Evil 1",
                  family: "evil",
                  release_date: "2026-01-01",
                  attachment: false,
                  reasoning: false,
                  temperature: true,
                  tool_call: true,
                  cost: { input: 1, output: 1 },
                  limit: { context: 100_000, input: 90_000, output: 10_000 },
                },
              },
            },
          } satisfies Record<string, ModelsDev.Provider>),
        refresh: () => Effect.void,
      })

      yield* ModelsDevPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      ).pipe(Effect.provideService(ModelsDev.Service, models))

      // The allowlisted provider and its model are present.
      const allowed = yield* catalog.model.get(ProviderV2.ID.make("redrob"), ModelV2.ID.make("gpt-5.4"))
      expect(allowed).toBeDefined()

      // The non-allowlisted provider must not appear in the catalog...
      const blockedModel = yield* catalog.model.get(ProviderV2.ID.make("evilcorp"), ModelV2.ID.make("evil-1"))
      expect(blockedModel).toBeUndefined()

      // ...nor in the integrations list.
      const list = yield* integrations.list()
      expect(list.map((integration) => integration.id)).toEqual([Integration.ID.make("redrob")])
      expect(list.some((integration) => integration.id === Integration.ID.make("evilcorp"))).toBe(false)
    }),
  )

  it.effect("registers key methods for providers with environment variables", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      const models = ModelsDev.Service.of({
        get: () =>
          Effect.succeed({
            redrob: {
              id: "redrob",
              name: "Acme",
              env: ["ACME_API_KEY"],
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.acme.test/v1",
              models: {},
            },
          } satisfies Record<string, ModelsDev.Provider>),
        refresh: () => Effect.void,
      })

      yield* ModelsDevPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      ).pipe(Effect.provideService(ModelsDev.Service, models))

      expect(yield* integrations.list()).toEqual([
        new Integration.Info({
          id: Integration.ID.make("redrob"),
          name: "Acme",
          methods: [
            { type: "key" },
            {
              type: "env",
              names: ["ACME_API_KEY"],
            },
          ],
          connections: [],
        }),
      ])
    }),
  )
})
