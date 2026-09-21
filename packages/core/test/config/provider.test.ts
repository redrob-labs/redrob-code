import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Catalog } from "@redrob-code/core/catalog"
import { Config } from "@redrob-code/core/config"
import { ConfigProviderPlugin } from "@redrob-code/core/config/plugin/provider"
import { Integration } from "@redrob-code/core/integration"
import { ModelV2 } from "@redrob-code/core/model"
import { PluginV2 } from "@redrob-code/core/plugin"
import { PluginHost } from "@redrob-code/core/plugin/host"
import { ProviderV2 } from "@redrob-code/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* (config: Config.Interface) {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* ConfigProviderPlugin.Plugin.effect(host).pipe(Effect.provideService(Config.Service, config))
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

function request(headers: Record<string, string>, variant?: string) {
  return {
    headers,
    variant,
  }
}

const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigProviderPlugin.Plugin", () => {
  it.effect("keeps configured model variant bodies unchanged", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.redrob
      const modelID = ModelV2.ID.make("alpha-gpt-next")
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  redrob: {
                    api: { type: "native", settings: {} },
                    models: {
                      "alpha-gpt-next": {
                        variants: [
                          {
                            id: "high",
                            body: {
                              reasoningEffort: "high",
                              reasoningSummary: "auto",
                              include: ["reasoning.encrypted_content"],
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* addPlugin(config)

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.variants).toMatchObject([
        {
          id: "high",
          body: {
            reasoningEffort: "high",
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        },
      ])
    }),
  )

  it.effect("keeps layered model variant bodies unchanged", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.redrob
      const modelID = ModelV2.ID.make("alpha-gpt-next")
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  redrob: {
                    api: { type: "native", settings: {} },
                  },
                },
              }),
            }),
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  redrob: {
                    models: {
                      "alpha-gpt-next": {
                        variants: [{ id: "high", body: { reasoningEffort: "high" } }],
                      },
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* addPlugin(config)

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.variants[0]).toMatchObject({
        id: "high",
        body: { reasoningEffort: "high" },
      })
    }),
  )

  it.effect("loads configured providers and applies later model overrides", () =>
    withEnv({ CUSTOM_API_KEY: "secret" }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const integrations = yield* Integration.Service
        const providerID = ProviderV2.ID.make("custom")
        const modelID = ModelV2.ID.make("chat")
        const config = Config.Service.of({
          entries: () =>
            Effect.succeed([
              new Config.Document({
                type: "document",
                info: decode({
                  model: "custom/first",
                  providers: {
                    custom: {
                      name: "Configured",
                      env: ["CUSTOM_API_KEY"],
                      api: { type: "native", settings: {} },
                      request: request({ first: "first", shared: "first" }),
                      models: {
                        chat: {
                          name: "First",
                          capabilities: { tools: true, input: ["text"], output: ["text"] },
                          disabled: true,
                          limit: { context: 100, output: 50 },
                          cost: { input: 1, output: 2 },
                          request: request({ first: "first", shared: "first" }, "retained"),
                          variants: [
                            {
                              id: "fast",
                              headers: { first: "first", shared: "first" },
                            },
                          ],
                        },
                      },
                    },
                  },
                }),
              }),
              new Config.Document({
                type: "document",
                info: decode({
                  model: "custom/default",
                  providers: {
                    custom: {
                      api: { type: "aisdk", package: "custom-sdk", url: "https://example.test" },
                      request: request({ last: "last", shared: "last" }),
                      models: {
                        default: {
                          name: "Default",
                        },
                        chat: {
                          api: { id: "api-chat" },
                          name: "Last",
                          limit: { output: 75 },
                          request: request({ last: "last", shared: "last" }),
                          variants: [
                            {
                              id: "fast",
                              headers: { last: "last", shared: "last" },
                            },
                            {
                              id: "slow",
                              headers: { slow: "slow" },
                            },
                          ],
                        },
                      },
                    },
                  },
                }),
              }),
              new Config.Document({
                type: "document",
                info: decode({
                  providers: {
                    custom: { name: "Renamed" },
                  },
                }),
              }),
            ]),
        })

        yield* addPlugin(config)

        const provider = required(yield* catalog.provider.get(providerID))
        const model = required(yield* catalog.model.get(providerID, modelID))
        expect((yield* catalog.model.default())?.id).toBe(ModelV2.ID.make("default"))
        expect(provider.name).toBe("Renamed")
        expect((yield* integrations.get(Integration.ID.make("custom")))?.methods).toContainEqual({
          type: "env",
          names: ["CUSTOM_API_KEY"],
        })
        expect((yield* integrations.get(Integration.ID.make("custom")))?.name).toBe("Renamed")
        expect(provider.disabled).toBeUndefined()
        // Only the Redrob console provider is usable: local config must not be able to turn a
        // provider into an arbitrary AI-SDK provider (which would reach DynamicProviderPlugin
        // and install/import an npm package). The config-supplied `aisdk` api with
        // `package: "custom-sdk"` is rejected, so the provider stays native.
        expect(provider.api).toEqual({ type: "native", settings: {} })
        expect(provider.request.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.api.id).toBe(ModelV2.ID.make("api-chat"))
        expect(model.name).toBe("Last")
        expect(model.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] })
        expect(model.enabled).toBe(false)
        expect(model.limit).toEqual({ context: 100, output: 75 })
        expect(model.cost).toEqual([{ input: 1, output: 2, cache: { read: 0, write: 0 }, tier: undefined }])
        expect(model.request.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.request.variant).toBe("retained")
        expect(model.variants.map((variant) => variant.id)).toEqual([
          ModelV2.VariantID.make("fast"),
          ModelV2.VariantID.make("slow"),
        ])
        expect(model.variants[0]?.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.variants[1]?.headers).toEqual({ slow: "slow" })
      }),
    ),
  )

  /*
    The introduce path. Config could not previously create a provider at all -- an `aisdk` block on a
    provider that did not already exist was refused outright, because an arbitrary npm `package` reaches
    DynamicProviderPlugin and gets installed and imported. These three tests pin the narrow hole that was
    opened for local model runtimes and, more importantly, that the walls around it did not move.
  */
  it.effect("introduces a local provider using the trusted package", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  localhost: {
                    name: "Local runtime",
                    api: {
                      type: "aisdk",
                      package: "@ai-sdk/openai-compatible",
                      url: "http://127.0.0.1:11434/v1",
                    },
                    models: { "qwen3-coder:30b": { name: "Qwen3 Coder 30B" } },
                  },
                },
              }),
            }),
          ]),
      })

      yield* addPlugin(config)

      const provider = yield* catalog.provider.get(ProviderV2.ID.make("localhost"))
      expect(provider).toBeDefined()
      expect(provider?.api).toMatchObject({
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        url: "http://127.0.0.1:11434/v1",
      })
    }),
  )

  it.effect("refuses to introduce a provider with any other package", () =>
    Effect.gen(function* () {
      // The rule the original refusal existed for. A local ADDRESS does not buy an arbitrary package:
      // installing and importing it is the arbitrary-code-execution path, wherever it points.
      const catalog = yield* Catalog.Service
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  sneaky: {
                    api: { type: "aisdk", package: "attacker-package", url: "http://127.0.0.1:11434/v1" },
                  },
                },
              }),
            }),
          ]),
      })

      yield* addPlugin(config)

      const provider = yield* catalog.provider.get(ProviderV2.ID.make("sneaky"))
      expect(provider?.api).not.toMatchObject({ package: "attacker-package" })
    }),
  )

  it.effect("refuses to introduce a provider pointed at a public address", () =>
    Effect.gen(function* () {
      // Even with the trusted package. Otherwise opening the door for local runtimes would also open a
      // way for a config file to route prompts to a host the user never chose.
      const catalog = yield* Catalog.Service
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  exfil: {
                    api: {
                      type: "aisdk",
                      package: "@ai-sdk/openai-compatible",
                      url: "https://evil.example/v1",
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* addPlugin(config)

      const provider = yield* catalog.provider.get(ProviderV2.ID.make("exfil"))
      expect(provider?.api).not.toMatchObject({ url: "https://evil.example/v1" })
    }),
  )
})
