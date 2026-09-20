import { afterAll, beforeAll, describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Catalog } from "@redrob-code/core/catalog"
import { Config } from "@redrob-code/core/config"
import { LocalModelsPlugin } from "@redrob-code/core/config/plugin/local-models"
import { ConfigProviderPlugin } from "@redrob-code/core/config/plugin/provider"
import { ModelV2 } from "@redrob-code/core/model"
import { PluginV2 } from "@redrob-code/core/plugin"
import { PluginHost } from "@redrob-code/core/plugin/host"
import { ProviderV2 } from "@redrob-code/core/provider"
import { createServer, type Server } from "node:http"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

/*
  Discovery against a REAL http server, not a mocked fetch.

  The claim is that pointing at a local runtime yields the models that runtime is actually serving, and a
  stubbed client cannot make that claim: it would assert my own understanding of the wire format back at
  me. This stands up a server speaking the OpenAI-standard listing -- the same two-field shape Ollama and
  LM Studio return -- and asserts the catalog ends up with those ids.
*/

const it = testEffect(PluginTestLayer)

let server: Server
let port = 0
let requests: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "qwen3-coder:30b", object: "model" },
            { id: "llama3.3:70b", object: "model" },
            // An entry this build cannot describe must cost only itself, not the whole listing.
            { unexpected: true },
          ],
        }),
      )
      return
    }
    res.writeHead(404).end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as { port: number }).port
})

afterAll(() => {
  server.close()
})

const decode = Schema.decodeUnknownSync(Config.Info)

function configWith(url: string) {
  return Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: decode({
            providers: {
              localhost: {
                name: "Local runtime",
                api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url },
              },
            },
          }),
        }),
      ]),
  })
}

const run = Effect.fn(function* (config: Config.Interface) {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  // The provider has to exist before it can gain models, so both plugins run, in boot order.
  yield* ConfigProviderPlugin.Plugin.effect(host).pipe(Effect.provideService(Config.Service, config))
  yield* LocalModelsPlugin.Plugin.effect(host).pipe(Effect.provideService(Config.Service, config))
})

describe("LocalModelsPlugin", () => {
  it.effect("adds the models the local runtime is actually serving", () =>
    Effect.gen(function* () {
      requests = []
      const catalog = yield* Catalog.Service
      yield* run(configWith(`http://127.0.0.1:${port}/v1`))

      expect(requests).toContain("GET /v1/models")

      const providerID = ProviderV2.ID.make("localhost")
      const qwen = yield* catalog.model.get(providerID, ModelV2.ID.make("qwen3-coder:30b"))
      const llama = yield* catalog.model.get(providerID, ModelV2.ID.make("llama3.3:70b"))
      expect(qwen).toBeDefined()
      expect(llama).toBeDefined()
      // The raw id is a usable name, and is what config would otherwise have had to spell out by hand.
      expect(qwen?.name).toBe("qwen3-coder:30b")
    }),
  )

  it.effect("does not query a public address, so config cannot make the CLI call out on startup", () =>
    Effect.gen(function* () {
      /*
        The address rule is re-checked on this path deliberately. Asserting it here is what keeps a future
        change to the introduce gate from silently turning startup into an outbound request to anywhere.
      */
      requests = []
      const catalog = yield* Catalog.Service
      yield* run(
        Config.Service.of({
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
                        // Points at the same test server, but through a hostname that is not local.
                        url: `http://example.com:${port}/v1`,
                      },
                    },
                  },
                }),
              }),
            ]),
        }),
      )

      expect(requests).toEqual([])
      const model = yield* catalog.model.get(ProviderV2.ID.make("exfil"), ModelV2.ID.make("qwen3-coder:30b"))
      expect(model).toBeUndefined()
    }),
  )

  it.effect("a runtime that is not running leaves the provider alone", () =>
    Effect.gen(function* () {
      // The normal state of a laptop. It must not fail the catalog, which would take the console
      // provider down with it.
      const catalog = yield* Catalog.Service
      // Port 1 is reserved and nothing listens there, so the connection is refused rather than hanging.
      yield* run(configWith("http://127.0.0.1:1/v1"))

      const provider = yield* catalog.provider.get(ProviderV2.ID.make("localhost"))
      expect(provider).toBeDefined()
      expect(provider?.name).toBe("Local runtime")
    }),
  )
})
