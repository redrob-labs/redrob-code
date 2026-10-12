import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Config, Context, Effect, Layer } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import * as Http from "node:http"
import { ControlPaths } from "../../src/server/routes/instance/httpapi/groups/control"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { DEFAULT_SPEECH_MODEL, DEFAULT_SPEECH_VOICE } from "../../src/tool/speech_generate"
import { testEffect } from "../lib/effect"

/**
 * `POST /redrob/speech` through the production route tree, with a stand-in for the Redrob gateway
 * behind it. What matters is that the app gets audio while the engine's key only ever goes to the
 * gateway, and that every refusal arrives as the endpoint's declared error.
 */

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)
const it = testEffect(
  servedRoutes.pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(NodeServices.layer),
  ),
)

const MP3 = new Uint8Array([0xff, 0xf3, 0x44, 0xc4, 0x01, 0x02])

type Seen = { authorization: string | undefined; body: unknown }
type Answer = { status: number; type: string; body: Uint8Array | string }

/** The engine pointed at the stand-in and holding a Redrob key, restored when the test scope closes. */
const engineEnv = (gatewayUrl: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const saved = {
        url: process.env.REDROB_CONSOLE_URL,
        auth: process.env.REDROB_AUTH_CONTENT,
        key: process.env.REDROB_API_KEY,
      }
      process.env.REDROB_CONSOLE_URL = gatewayUrl
      process.env.REDROB_AUTH_CONTENT = JSON.stringify({ redrob: { type: "api", key: "rk_engine_key" } })
      delete process.env.REDROB_API_KEY
      return saved
    }),
    (saved) =>
      Effect.sync(() => {
        for (const [name, value] of [
          ["REDROB_CONSOLE_URL", saved.url],
          ["REDROB_AUTH_CONTENT", saved.auth],
          ["REDROB_API_KEY", saved.key],
        ] as const) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      }),
  )

/**
 * Topology: the engine's routes run on the test's primary server (NodeHttpServer.layerTest), and the
 * Redrob gateway stand-in is a second listener built into this test's scope with its own fresh router,
 * so its `/audio/speech` cannot collide with anything the engine registers. The engine reaches the
 * stand-in through `REDROB_CONSOLE_URL`, the developer seam the gateway URL already honours.
 */
const gateway = Effect.fn("SpeechTest.gateway")(function* (answer: (body: Record<string, unknown>) => Answer) {
  const seen: Seen[] = []
  const context = yield* Layer.build(
    Layer.mergeAll(
      Layer.fresh(HttpRouter.layer),
      NodeHttpServer.layer(() => Http.createServer(), { host: "127.0.0.1", port: 0 }),
    ),
  )
  const server = Context.get(context, HttpServer.HttpServer)
  const router = Context.get(context, HttpRouter.HttpRouter)
  yield* router.add(
    "POST",
    "/audio/speech",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const raw = yield* request.json.pipe(Effect.orElseSucceed(() => ({})))
      const body = typeof raw === "object" && raw !== null ? Object.fromEntries(Object.entries(raw)) : {}
      seen.push({ authorization: request.headers.authorization, body })
      const reply = answer(body)
      return typeof reply.body === "string"
        ? HttpServerResponse.text(reply.body, { status: reply.status, contentType: reply.type })
        : HttpServerResponse.uint8Array(reply.body, { status: reply.status, contentType: reply.type })
    }),
  )
  yield* server.serve(router.asHttpEffect())
  if (server.address._tag !== "TcpAddress") throw new Error("expected a TCP listener")
  yield* engineEnv(`http://127.0.0.1:${server.address.port}`)
  return { seen }
})

const speak = (payload: Record<string, unknown>) =>
  HttpClientRequest.post(ControlPaths.speech).pipe(
    HttpClientRequest.bodyJson(payload),
    Effect.flatMap(HttpClient.execute),
  )

describe("redrob speech HttpApi", () => {
  it.live("answers with the gateway's mp3, sending the engine's key only to the gateway", () =>
    Effect.gen(function* () {
      const { seen } = yield* gateway(() => ({ status: 200, type: "audio/mpeg", body: MP3 }))
      const response = yield* speak({ text: "안녕하세요" })

      expect(response.status).toBe(200)
      expect(response.headers["content-type"]).toContain("audio/mpeg")
      expect(new Uint8Array(yield* response.arrayBuffer)).toEqual(MP3)
      expect(seen).toEqual([
        {
          authorization: "Bearer rk_engine_key",
          body: {
            model: DEFAULT_SPEECH_MODEL,
            input: "안녕하세요",
            response_format: "mp3",
            voice: DEFAULT_SPEECH_VOICE,
          },
        },
      ])
    }),
  )

  it.live("refuses empty or over-long text with a 400, sending nothing", () =>
    Effect.gen(function* () {
      const { seen } = yield* gateway(() => ({ status: 200, type: "audio/mpeg", body: MP3 }))
      expect((yield* speak({ text: "   " })).status).toBe(400)
      expect((yield* speak({ text: "가".repeat(4097) })).status).toBe(400)
      expect(seen).toHaveLength(0)
    }),
  )

  it.live("without a Redrob key it is a 503, sending nothing", () =>
    Effect.gen(function* () {
      const { seen } = yield* gateway(() => ({ status: 200, type: "audio/mpeg", body: MP3 }))
      process.env.REDROB_AUTH_CONTENT = JSON.stringify({})
      const response = yield* speak({ text: "Hello" })
      expect(response.status).toBe(503)
      expect(JSON.stringify(yield* response.json)).toContain("Connect Redrob")
      expect(seen).toHaveLength(0)
    }),
  )

  it.live("a gateway refusal, or an answer that is not audio, is a 502 with the gateway's message", () =>
    Effect.gen(function* () {
      yield* gateway((body) =>
        body.input === "json"
          ? { status: 200, type: "application/json", body: "{}" }
          : { status: 402, type: "application/json", body: JSON.stringify({ error: { message: "Out of credit." } }) },
      )
      const refused = yield* speak({ text: "Hello" })
      expect(refused.status).toBe(502)
      expect(JSON.stringify(yield* refused.json)).toContain("answered 402: Out of credit.")
      const json = yield* speak({ text: "json" })
      expect(json.status).toBe(502)
      expect(JSON.stringify(yield* json.json)).toContain("not audio")
    }),
  )
})
