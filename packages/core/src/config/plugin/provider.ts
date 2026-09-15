export * as ConfigProviderPlugin from "./provider"

import { define } from "../../plugin/internal"
import { Effect } from "effect"
import { Config } from "../../config"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"

export const Plugin = define({
  id: "config-provider",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    yield* ctx.integration.transform(
      Effect.fn(function* (integrations) {
        const files = (yield* config.entries()).filter((entry): entry is Config.Document => entry.type === "document")
        const configuredIntegrations = new Set(
          files.flatMap((file) =>
            Object.entries(file.info.providers ?? {}).flatMap(([id, provider]) =>
              provider.env === undefined ? [] : [id],
            ),
          ),
        )
        for (const file of files) {
          for (const [id, item] of Object.entries(file.info.providers ?? {})) {
            const integrationID = id
            if (!configuredIntegrations.has(id) && !integrations.get(integrationID)) continue
            integrations.update(integrationID, (integration) => {
              integration.name = item.name ?? integration.name
            })
            if (item.env !== undefined) {
              integrations.method.update({
                integrationID,
                method: { type: "env", names: [...item.env] },
              })
            }
          }
        }
      }),
    )

    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        const entries = yield* config.entries()
        const files = entries.filter((entry): entry is Config.Document => entry.type === "document")
        const configuredDefault = Config.latest(entries, "model")
        if (configuredDefault !== undefined) {
          const model = ModelV2.parse(configuredDefault)
          catalog.model.default.set(model.providerID, model.modelID)
        }
        for (const file of files) {
          for (const [id, item] of Object.entries(file.info.providers ?? {})) {
            const providerID = id
            catalog.provider.update(providerID, (provider) => {
              if (item.name !== undefined) provider.name = item.name
              // Only the Redrob console provider is usable. Local config must not be able to
              // introduce a new AI-SDK provider (`type: "aisdk"` with an npm `package`) or
              // swap the `package` of an existing aisdk provider, either of which would reach
              // DynamicProviderPlugin and install/import an arbitrary npm package — a way to
              // run a non-console provider. Config may still refine a provider's
              // endpoint/settings, but never the aisdk `package`.
              if (item.api !== undefined) {
                const itemApi = item.api
                const introducesAisdk = itemApi.type === "aisdk" && provider.api.type !== "aisdk"
                if (introducesAisdk) {
                  // Config tries to turn the provider into an aisdk provider — refuse it.
                } else if (
                  itemApi.type === "aisdk" &&
                  provider.api.type === "aisdk" &&
                  itemApi.package !== provider.api.package
                ) {
                  // Existing aisdk provider — refine endpoint/settings but keep the trusted
                  // `package`, never the config-supplied one.
                  const { package: _ignored, ...rest } = itemApi
                  provider.api = { ...provider.api, ...rest }
                } else {
                  provider.api = { ...item.api }
                }
              }
              if (item.request !== undefined) {
                Object.assign(provider.request.headers, item.request.headers)
                Object.assign(provider.request.body, item.request.body)
              }
            })
            for (const [id, config] of Object.entries(item.models ?? {})) {
              catalog.model.update(providerID, id, (model) => {
                if (config.family !== undefined) model.family = config.family
                if (config.name !== undefined) model.name = config.name
                // Same guard as the provider-level api above: local config may refine an
                // existing model's api (id/url/settings) but must never introduce a new aisdk
                // `package` or swap the `package` of an already-aisdk console model. Either
                // would reach DynamicProviderPlugin and install/import an arbitrary npm
                // package. When config would change the `package`, drop that field from the
                // merge so the trusted console `package` always wins, while still applying the
                // rest of the refinement (url/settings/id/etc.).
                if (config.api !== undefined) {
                  const configApi = config.api
                  const configIsAisdk = "type" in configApi && configApi.type === "aisdk"
                  if (configIsAisdk && model.api.type !== "aisdk") {
                    // Config tries to turn a native model into an aisdk model — refuse the
                    // whole transition, keeping the trusted native api untouched.
                  } else if (configIsAisdk && model.api.type === "aisdk" && configApi.package !== model.api.package) {
                    // Existing aisdk (console) model — allow refinement but keep the trusted
                    // `package`, dropping only the config-supplied one from the merge.
                    const { package: _ignored, ...rest } = configApi
                    model.api = { ...model.api, ...rest }
                  } else {
                    model.api = { ...model.api, ...configApi }
                  }
                }
                if (config.capabilities !== undefined) {
                  model.capabilities = {
                    tools: config.capabilities.tools,
                    input: [...config.capabilities.input],
                    output: [...config.capabilities.output],
                  }
                }
                if (config.request !== undefined) {
                  Object.assign(model.request.headers, config.request.headers)
                  Object.assign(model.request.body, config.request.body)
                  if (config.request.variant !== undefined) model.request.variant = config.request.variant
                }
                if (config.variants !== undefined) {
                  for (const variant of config.variants) {
                    let existing = model.variants.find((item) => item.id === variant.id)
                    if (!existing) {
                      existing = {
                        id: variant.id,
                        headers: {},
                        body: {},
                      }
                      model.variants.push(existing)
                    }
                    Object.assign(existing.headers, variant.headers)
                    Object.assign(existing.body, variant.body)
                  }
                }
                if (config.cost !== undefined) {
                  model.cost = (Array.isArray(config.cost) ? config.cost : [config.cost]).map((cost) => ({
                    tier: cost.tier && { ...cost.tier },
                    input: cost.input,
                    output: cost.output,
                    cache: {
                      read: cost.cache?.read ?? 0,
                      write: cost.cache?.write ?? 0,
                    },
                  }))
                }
                if (config.disabled !== undefined) model.enabled = !config.disabled
                if (config.limit !== undefined) model.limit = { ...model.limit, ...config.limit }
              })
            }
          }
        }
      }),
    )
  }),
})
