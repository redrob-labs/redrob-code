import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Flag } from "@redrob-code/core/flag/flag"
import { describe, expect } from "bun:test"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

// The OpenAI-compatible route is what every Redrob app (Grow, Canvas, Recall, Office) calls
// on the shared daemon. v0.6.4 shipped with the route's service graph missing the LLM client, so
// every call -- with or without tools, any model -- died with a 500 "Service not found:
// @redrob/LLMClient" before a provider was even chosen. This test drives the production route tree
// and only asserts the one thing that bug broke: the request reaches the model layer. Whatever
// the provider answers without a credential is fine; a missing service is not.

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const original = { REDROB_SERVER_PASSWORD: Flag.REDROB_SERVER_PASSWORD }
    Flag.REDROB_SERVER_PASSWORD = "secret"
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        Flag.REDROB_SERVER_PASSWORD = original.REDROB_SERVER_PASSWORD
        await resetDatabase()
      }),
    )
  }),
)

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)

const it = testEffect(
  Layer.mergeAll(
    testStateLayer,
    servedRoutes.pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
)

const basic = "Basic " + Buffer.from("redrob:secret").toString("base64")

describe("POST /v1/chat/completions", () => {
  it.live("reaches the model layer instead of failing on a missing LLM client service", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/v1/chat/completions").pipe(
        HttpClientRequest.setHeaders({ authorization: basic, "x-redrob-app": "grow" }),
        HttpClientRequest.bodyJson({
          model: "redrob/auto",
          messages: [{ role: "user", content: "say OK" }],
          tools: [
            {
              type: "function",
              function: { name: "note", description: "record a note", parameters: { type: "object", properties: {} } },
            },
          ],
        }),
        Effect.flatMap(HttpClient.execute),
      )
      const text = yield* response.text
      expect(text).not.toContain("Service not found")
      expect(response.status).not.toBe(500)
    }),
  )
})
