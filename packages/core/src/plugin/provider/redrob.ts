import { Effect, Semaphore, Stream } from "effect"
import type { Scope } from "effect"
import { define } from "@redrob-code/plugin/v2/effect/plugin"
import { EventV2 } from "../../event"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import {
  CONSOLE_CONTEXT_TOKENS,
  CONSOLE_MODEL,
  CONSOLE_MODEL_ID,
  CONSOLE_MODEL_IDS,
  CONSOLE_MODELS,
  CONSOLE_OUTPUT_TOKENS,
  CONSOLE_PACKAGE,
  CONSOLE_URL,
} from "./redrob-constants"

// The console provider constants are the single source of truth for the console provider:
// they live in the dependency-free ./redrob-constants leaf module so the dynamic
// ModelsDev.Service and the V1 seed (packages/redrob/src/provider/provider.ts) can import
// them without an import cycle, and the three registrations cannot drift.
export {
  CONSOLE_URL,
  CONSOLE_PACKAGE,
  CONSOLE_MODEL,
  CONSOLE_MODEL_ID,
  CONSOLE_MODEL_IDS,
  CONSOLE_MODELS,
  CONSOLE_CONTEXT_TOKENS,
  CONSOLE_OUTPUT_TOKENS,
}

export const RedrobPlugin = define<EventV2.Service | Scope.Scope>({
  id: "redrob",
  effect: Effect.fn(function* (ctx) {
    const events = yield* EventV2.Service
    const loading = Semaphore.makeUnsafe(1)
    let connected = false

    const load = Effect.fn("RedrobPlugin.load")(function* () {
      connected = (yield* ctx.integration.connection.active("redrob")) !== undefined
    })

    yield* ctx.integration.transform((draft) => {
      draft.update("redrob", (integration) => {
        integration.name = "Redrob Code"
      })
      draft.method.update({ integrationID: "redrob", method: { type: "key", label: "Redrob API key" } })
    })

    connected = (yield* ctx.integration.connection.active("redrob")) !== undefined
    yield* ctx.catalog.transform((catalog) => {
      catalog.provider.update(ProviderV2.ID.redrob, (provider) => {
        provider.integrationID = Integration.ID.make("redrob")
        provider.name = "Redrob"
        provider.api = { type: "aisdk", package: CONSOLE_PACKAGE, url: CONSOLE_URL }
      })

      for (const entry of CONSOLE_MODELS) {
        const modelID = ModelV2.ID.make(entry.id)
        catalog.model.update(ProviderV2.ID.redrob, modelID, (model) => {
          model.name = entry.name
          model.api = { id: modelID, type: "aisdk", package: CONSOLE_PACKAGE, url: CONSOLE_URL }
          model.capabilities = { tools: true, input: ["text"], output: ["text"] }
          // This is the static registration, which runs with or without a key, so it carries no
          // rate: the console's live listing is the only authoritative source of one and
          // ModelsDevPlugin projects it from there. Limits do come from the verified capabilities
          // block, because a zero context window disables auto-compaction rather than deferring it.
          model.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
          model.limit = { context: CONSOLE_CONTEXT_TOKENS, output: CONSOLE_OUTPUT_TOKENS }
          model.status = "active"
          model.enabled = true
        })
      }

      const item = catalog.provider.get(ProviderV2.ID.redrob)
      if (!item) return
      const hasKey = Boolean(process.env.REDROB_API_KEY || connected || item.provider.request.body.apiKey)
      // Without a key the SDK still needs a non-empty apiKey to instantiate, so it gets a
      // placeholder. What used to follow was a loop disabling every model priced above 0, inherited
      // from providers that mix free and paid models. The console has no free tier — one key gates
      // all six ids — so the price of a model says nothing about whether to list it, and now that
      // the listing's real rates are projected that loop would have emptied the catalog for every
      // keyless user instead of leaving it browsable.
      if (hasKey) return
      catalog.provider.update(item.provider.id, (provider) => {
        provider.request.body.apiKey = "public"
      })
    })

    const refresh = () => loading.withPermit(load().pipe(Effect.andThen(ctx.catalog.reload())))
    yield* events.subscribe(Integration.Event.ConnectionUpdated).pipe(
      Stream.filter((event) => event.data.integrationID === Integration.ID.make("redrob")),
      Stream.runForEach(refresh),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* refresh().pipe(Effect.forkScoped)
  }),
})
