import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Flag } from "@redrob-code/core/flag/flag"
import { describe, expect } from "bun:test"
import { Config, ConfigProvider, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import type { CorsOptions } from "@redrob-code/server/cors"
import { Server } from "../../src/server/server"
import { InstancePaths } from "../../src/server/routes/instance/httpapi/groups/instance"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const original = {
      REDROB_SERVER_PASSWORD: Flag.REDROB_SERVER_PASSWORD,
    }
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

// Origin policy is asserted through the real route tree's web handler so the
// assertions cover the production CORS middleware wiring, not the helper alone.
const webHandler = (options?: CorsOptions) =>
  HttpRouter.toWebHandler(
    HttpApiApp.createRoutes(options).pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ REDROB_SERVER_PASSWORD: "secret" }))),
    ),
    { disableLogger: true },
  ).handler

describe("HttpApi CORS", () => {
  it.live("allows browser preflight requests without credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.options(InstancePaths.path).pipe(
        HttpClientRequest.setHeaders({
          origin: "http://localhost:3000",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        }),
        HttpClient.execute,
      )

      expect(response.status).toBe(204)
      expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000")
      expect(response.headers["access-control-allow-headers"]).toBe("authorization")
    }),
  )

  it.live("adds CORS headers to unauthorized responses", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        webHandler()(
          new Request(new URL("/global/config", "http://localhost"), {
            headers: { origin: "http://localhost:3000" },
          }),
          HttpApiApp.context,
        ),
      )

      expect(response.status).toBe(401)
      expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    }),
  )

  // Redrob Work is the sole GUI and reaches the engine over local origins, so hosted
  // redrob.ai pages get no blanket CORS allowance.
  it.live("rejects remote redrob.ai browser origins", () =>
    Effect.gen(function* () {
      const handler = webHandler()

      for (const origin of ["https://app.code.redrob.ai", "https://console.redrob.ai"]) {
        const response = yield* Effect.promise(() =>
          handler(
            new Request(new URL("/global/config", "http://localhost"), { headers: { origin } }),
            HttpApiApp.context,
          ),
        )

        expect(response.headers.get("access-control-allow-origin")).not.toBe(origin)
      }
    }),
  )

  it.live("allows a redrob.ai origin only when explicitly configured", () =>
    Effect.gen(function* () {
      const handler = webHandler({ cors: ["https://app.code.redrob.ai"] })

      const configured = yield* Effect.promise(() =>
        handler(
          new Request(new URL("/global/config", "http://localhost"), {
            headers: { origin: "https://app.code.redrob.ai" },
          }),
          HttpApiApp.context,
        ),
      )
      expect(configured.headers.get("access-control-allow-origin")).toBe("https://app.code.redrob.ai")

      const other = yield* Effect.promise(() =>
        handler(
          new Request(new URL("/global/config", "http://localhost"), {
            headers: { origin: "https://console.redrob.ai" },
          }),
          HttpApiApp.context,
        ),
      )
      expect(other.headers.get("access-control-allow-origin")).not.toBe("https://console.redrob.ai")
    }),
  )

  it.live("uses custom CORS origins passed to the server", () =>
    Effect.gen(function* () {
      const listener = yield* Effect.acquireRelease(
        Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0, cors: ["https://custom.example"] })),
        (listener) => Effect.promise(() => listener.stop(true)),
      )

      const response = yield* Effect.promise(() =>
        fetch(new URL(InstancePaths.path, listener.url), {
          method: "OPTIONS",
          headers: {
            origin: "https://custom.example",
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization",
          },
        }),
      )

      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-origin")).toBe("https://custom.example")
      expect(response.headers.get("access-control-allow-headers")).toBe("authorization")

      const rejected = yield* Effect.promise(() =>
        fetch(new URL(InstancePaths.path, listener.url), {
          method: "OPTIONS",
          headers: {
            origin: "https://evil.example",
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization",
          },
        }),
      )

      expect(rejected.status).toBe(204)
      expect(rejected.headers.get("access-control-allow-origin")).not.toBe("https://evil.example")
    }),
  )
})
