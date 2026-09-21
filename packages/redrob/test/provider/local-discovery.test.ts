import { afterAll, beforeAll, expect } from "bun:test"
import { createServer, type Server } from "node:http"
import { Effect } from "effect"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@redrob-code/core/provider"
import { testEffect } from "../lib/effect"

/**
 * A local model runtime, discovered rather than written out by hand -- on the V1 path, which is the one
 * the desktop apps actually read.
 *
 * Why this matters more than it looks: cowork's own provider filter drops a `custom`-source provider
 * unless it has at least one model. So a config-declared local runtime with no hand-written model list is
 * not merely sparse in the model picker, it is INVISIBLE there. Discovery is what makes it appear.
 *
 * Driven against a real http server rather than a stubbed fetch: a stub would only assert my own
 * understanding of the wire format back at me, and the format is the whole interface to Ollama and
 * LM Studio.
 */

let server: Server
let requests: string[] = []

/*
  A FIXED port, not an ephemeral one. `it.instance` takes its config object at module-evaluation time,
  before any hook has run, so a port chosen by the OS is not knowable in time to put in that config.
  Picked high and specific to keep the collision risk small.
*/
const PORT = 11439

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
            // One entry this build cannot describe must cost only itself, not the whole listing.
            { unexpected: true },
          ],
        }),
      )
      return
    }
    res.writeHead(404).end("{}")
  })
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve))
})

afterAll(() => {
  server.close()
})

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node])))

const list = Effect.gen(function* () {
  const provider = yield* Provider.Service
  return yield* provider.list()
})

it.instance(
  "a local runtime's models are discovered, so the provider is not empty",
  Effect.gen(function* () {
    const providers = yield* list
    const local = providers[ProviderV2.ID.make("localhost")]
    expect(local).toBeDefined()
    expect(requests).toContain("GET /v1/models")

    const ids = Object.keys(local?.models ?? {})
    expect(ids).toContain("qwen3-coder:30b")
    expect(ids).toContain("llama3.3:70b")
  }),
  {
    config: {
      provider: {
        localhost: {
          name: "Local runtime",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `http://127.0.0.1:${PORT}/v1` },
        },
      },
    },
  },
)

it.instance(
  "a provider pointed at a public address is not queried",
  Effect.gen(function* () {
    /*
      The gate is re-applied on this path deliberately. Without it, a config file could make startup issue
      a request to any host it named -- and a project config travels with a cloned repository.
    */
    requests = []
    const providers = yield* list
    const remote = providers[ProviderV2.ID.make("remote")]
    // The provider may still exist -- V1 allows config providers -- but nothing was fetched for it.
    expect(requests).toEqual([])
    expect(Object.keys(remote?.models ?? {})).toEqual([])
  }),
  {
    config: {
      provider: {
        remote: {
          name: "Somewhere else",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://evil.example/v1" },
        },
      },
    },
  },
)
