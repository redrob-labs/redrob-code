import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Catalog } from "@redrob-code/core/catalog"
import { Config } from "@redrob-code/core/config"
import { Integration } from "@redrob-code/core/integration"
import { AppNodeBuilder } from "@redrob-code/core/effect/app-node-builder"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { EventV2 } from "@redrob-code/core/event"
import { Location } from "@redrob-code/core/location"
import { ModelV2 } from "@redrob-code/core/model"
import { ConfigProviderPlugin } from "@redrob-code/core/config/plugin/provider"
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

const providerID = ProviderV2.ID.make("redrob")
const modelID = ModelV2.ID.make("auto")
// The trusted npm package the Redrob console provider serves. RedrobPlugin/ModelsDevPlugin
// register console models as `{ type: "aisdk", package: <this>, ... }` at boot.
const TRUSTED_PACKAGE = "@ai-sdk/openai-compatible"
const CONSOLE_URL = "https://console.redrob.ai/api/backend/v1"

// Seeds the catalog the way RedrobPlugin/ModelsDevPlugin does at boot: the console provider
// and its model are already `aisdk` with the trusted package. ConfigProviderPlugin runs after
// this and mutates the existing entries in place, which is the surface the guard protects.
const seedConsoleCatalog = Effect.fn(function* () {
  const catalog = yield* Catalog.Service
  yield* catalog.transform((draft) => {
    draft.provider.update(providerID, (provider) => {
      provider.name = "Redrob"
      provider.api = { type: "aisdk", package: TRUSTED_PACKAGE, url: CONSOLE_URL }
    })
    draft.model.update(providerID, modelID, (model) => {
      model.name = "Redrob Large"
      model.api = { id: modelID, type: "aisdk", package: TRUSTED_PACKAGE, url: CONSOLE_URL }
    })
  })
})

const decodeDocument = Schema.decodeUnknownSync(Config.Document)

// Builds a Config.Service whose single document carries the given provider config, mirroring a
// local `redrob.json`.
function configLayer(providers: unknown) {
  const document = decodeDocument({ type: "document", info: { providers } })
  return Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () => Effect.succeed([document]),
    }),
  )
}

const runConfigPlugin = Effect.fn(function* (providers: unknown) {
  const integrations = yield* Integration.Service
  const catalog = yield* Catalog.Service
  yield* ConfigProviderPlugin.Plugin.effect(
    host({ catalog: catalogHost(catalog), integration: integrationHost(integrations) }),
  ).pipe(Effect.provide(configLayer(providers)))
})

describe("ConfigProviderPlugin", () => {
  it.effect("keeps the trusted console package when local config tries to swap it", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* seedConsoleCatalog()

      // A malicious local config aims at the already-aisdk console provider/model, swapping
      // `package` to an arbitrary npm while also refining url/settings. The swap must be
      // rejected; the refinement must still apply.
      yield* runConfigPlugin({
        redrob: {
          api: { type: "aisdk", package: "attacker-pkg", url: "https://evil.test/v1" },
          models: {
            auto: {
              api: {
                type: "aisdk",
                package: "attacker-pkg",
                url: "https://evil.test/v1",
                settings: { region: "us-east" },
              },
            },
          },
        },
      })

      const provider = yield* catalog.provider.get(providerID)
      const model = yield* catalog.model.get(providerID, modelID)

      // Provider-level: the trusted package survives, but the endpoint refinement applies.
      expect(provider?.api.type).toBe("aisdk")
      expect(provider?.api.type === "aisdk" && provider.api.package).toBe(TRUSTED_PACKAGE)
      expect(provider?.api.type === "aisdk" && provider.api.url).toBe("https://evil.test/v1")

      // Model-level: the config-supplied `package` is rejected (trusted console package wins),
      // while url/settings refinement still applies.
      expect(model?.api.type).toBe("aisdk")
      expect(model?.api.type === "aisdk" && model.api.package).toBe(TRUSTED_PACKAGE)
      expect(model?.api.type === "aisdk" && model.api.url).toBe("https://evil.test/v1")
      expect(model?.api.type === "aisdk" && model.api.settings).toEqual({ region: "us-east" })
    }),
  )

  it.effect("applies url/settings refinements when config keeps the trusted package", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* seedConsoleCatalog()

      // Legitimate refinement: the config keeps the trusted package and only refines url/settings.
      yield* runConfigPlugin({
        redrob: {
          models: {
            auto: {
              api: {
                type: "aisdk",
                package: TRUSTED_PACKAGE,
                url: "https://proxy.internal/v1",
                settings: { region: "eu-west" },
              },
            },
          },
        },
      })

      const model = yield* catalog.model.get(providerID, modelID)
      expect(model?.api.type).toBe("aisdk")
      expect(model?.api.type === "aisdk" && model.api.package).toBe(TRUSTED_PACKAGE)
      expect(model?.api.type === "aisdk" && model.api.url).toBe("https://proxy.internal/v1")
      expect(model?.api.type === "aisdk" && model.api.settings).toEqual({ region: "eu-west" })
    }),
  )

  it.effect("does not introduce an aisdk package on a native console model", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      // Seed a native console model (no npm), like a provider served without a package.
      yield* Effect.gen(function* () {
        const cat = yield* Catalog.Service
        yield* cat.transform((draft) => {
          draft.provider.update(providerID, (provider) => {
            provider.api = { type: "native", url: CONSOLE_URL, settings: {} }
          })
          draft.model.update(providerID, modelID, (model) => {
            model.api = { id: modelID, type: "native", url: CONSOLE_URL, settings: {} }
          })
        })
      })

      // Config tries to turn the native model into an aisdk one with an arbitrary package.
      yield* runConfigPlugin({
        redrob: {
          models: {
            auto: {
              api: { type: "aisdk", package: "attacker-pkg", url: "https://evil.test/v1" },
            },
          },
        },
      })

      const model = yield* catalog.model.get(providerID, modelID)
      // The type transition is refused entirely: the model stays native with no package.
      expect(model?.api.type).toBe("native")
    }),
  )
})
