export * as LocalModelsPlugin from "./local-models"

import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

import { Config } from "../../config"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { define } from "../../plugin/internal"
import { LOCAL_PROVIDER_PACKAGE, isLocalEndpoint } from "./local-provider"

/**
 * Asking a local model runtime what it is serving, instead of making the user write it down.
 *
 * A config-declared local provider can list its models by hand, but that list goes stale the moment the
 * user pulls a new one -- with Ollama that is a one-line command people run constantly. Every local
 * runtime worth pointing at serves the OpenAI-standard `GET /models`, the same listing the console
 * catalog is built from, so the same approach works here.
 *
 * WHY THE FETCH HAPPENS BEFORE THE TRANSFORM. `ctx.catalog.transform` takes a function returning
 * `void | Effect<void, never, never>` -- no requirements, no errors -- so an HTTP call cannot live inside
 * it. Rather than work around that, the providers are read from CONFIG directly, which is where they are
 * declared anyway, and their listings are fetched up front; the transform then only applies what is
 * already in hand, synchronously. This also removes an ordering dependency on whichever plugin put the
 * provider in the catalog.
 *
 * BEST-EFFORT. A local runtime that is not running is the normal state of a laptop, not an error. A
 * failed fetch leaves the provider exactly as config declared it and logs at debug level. Anything
 * louder would make every start of the CLI complain about a model server the user is not using today.
 *
 * GATED BY THE SAME RULE AS THE PROVIDER. This is an outbound request built from a config file, so it
 * re-checks `isLocalEndpoint` instead of trusting that the provider was gated on the way in. Two
 * independent checks of the same rule is the point: a later change that loosens one must not silently
 * turn this into a way to make the CLI call an arbitrary host on startup.
 *
 * FAST TO FAIL. The timeout is short because the premise is a server on this machine or this LAN. The
 * console's fetch can afford ten seconds over the internet; waiting that long for loopback only delays
 * the CLI when the runtime is down.
 */

/** The short timeout a local address justifies. */
const LOCAL_FETCH_TIMEOUT = "2 seconds"

/**
 * Only `data[].id` is required, and entries are decoded ONE AT A TIME.
 *
 * All-or-nothing decoding is what made the console catalog silently collapse to its fallback when a
 * single entry was unexpected. One model this build cannot describe should cost that model, not the list.
 */
const LocalModel = Schema.Struct({
  id: Schema.String,
  object: Schema.optional(Schema.String),
  created: Schema.optional(Schema.Finite),
})

const LocalModelList = Schema.Struct({
  object: Schema.optional(Schema.String),
  data: Schema.Array(Schema.Unknown),
})

/**
 * `<base>/models`, joined without caring whether the base already ends in a slash.
 *
 * A config file will be written both ways, and a doubled slash is a 404 on some runtimes.
 */
export function modelsUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/models`
}

/** Whether this api block is one this plugin may query. Same rule as the introduce gate, re-checked. */
export function isLocalApi(api: {
  readonly type?: string
  readonly package?: string
  readonly url?: string
}): api is { type: "aisdk"; package: string; url: string } {
  if (api.type !== "aisdk") return false
  if (api.package !== LOCAL_PROVIDER_PACKAGE) return false
  if (typeof api.url !== "string") return false
  return isLocalEndpoint(api.url)
}

export const Plugin = define({
  id: "local-models",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const http = yield* HttpClient.HttpClient

    const fetchModels = Effect.fn("LocalModels.fetch")(function* (url: string) {
      const res = yield* http.execute(HttpClientRequest.get(modelsUrl(url))).pipe(
        Effect.timeout(LOCAL_FETCH_TIMEOUT),
      )
      if (res.status < 200 || res.status >= 300) {
        return yield* Effect.fail(new Error(`local /models returned ${res.status}`))
      }
      const body = yield* res.text
      const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(LocalModelList))(body)
      if (decoded._tag === "None") return yield* Effect.fail(new Error("could not parse local /models"))

      const ids: string[] = []
      for (const entry of decoded.value.data) {
        const model = Schema.decodeUnknownOption(LocalModel)(entry)
        if (model._tag === "None") continue
        if (model.value.id.length === 0) continue
        ids.push(model.value.id)
      }
      return ids
    })

    /*
      Read the declared local providers, then fetch each listing. Failures collapse to an empty list so
      one unreachable runtime cannot stop the catalog being built -- which would take the console provider
      down with it.
    */
    const entries = yield* config.entries().pipe(Effect.catch(() => Effect.succeed([] as Config.Entry[])))
    const files = entries.filter((entry): entry is Config.Document => entry.type === "document")

    const discovered = new Map<string, string[]>()
    for (const file of files) {
      for (const [id, item] of Object.entries(file.info.providers ?? {})) {
        if (item.api === undefined || !isLocalApi(item.api)) continue
        const ids = yield* fetchModels(item.api.url).pipe(
          Effect.catch((error) =>
            Effect.logDebug(`LocalModels: ${id} at ${item.api?.url} did not answer: ${error}`).pipe(
              Effect.as([] as string[]),
            ),
          ),
        )
        if (ids.length === 0) continue
        discovered.set(id, ids)
        yield* Effect.logDebug(`LocalModels: ${id} is serving ${ids.length} model(s)`)
      }
    }

    if (discovered.size === 0) return

    yield* ctx.catalog.transform((catalog) => {
      for (const [providerID, ids] of discovered) {
        for (const id of ids) {
          catalog.model.update(ProviderV2.ID.make(providerID), ModelV2.ID.make(id), (model) => {
            /*
              The name is only DEFAULTED, never overwritten: a config file that gave a model a readable
              name meant it, and the runtime's raw id (`qwen3-coder:30b`) is what that name replaced.
            */
            if (!model.name || model.name.length === 0) model.name = id
          })
        }
      }
    })
  }),
})
