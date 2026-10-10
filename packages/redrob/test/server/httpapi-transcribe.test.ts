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
import { DEFAULT_TRANSCRIPTION_MODEL, MAX_TRANSCRIPTION_BYTES } from "../../src/redrob/transcription"
import { testEffect } from "../lib/effect"

/**
 * `POST /redrob/transcribe` through the production route tree, with a stand-in for the Redrob
 * gateway behind it. What matters is that the app gets a transcript while the engine's key only ever
 * goes to the gateway, that a request the gateway would refuse is refused here before anything is
 * sent, and that every refusal arrives as the endpoint's declared error.
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

/** A few bytes standing in for a webm/opus recording; the gateway stand-in never decodes them. */
const CLIP = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]).toString("base64")

type Seen = { authorization: string | undefined; body: unknown }
type Answer = { status: number; body: string }

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
 * so its `/audio/transcriptions` cannot collide with anything the engine registers. The engine reaches
 * the stand-in through `REDROB_CONSOLE_URL`, the developer seam the gateway URL already honours.
 */
const gateway = Effect.fn("TranscribeTest.gateway")(function* (answer: (body: Record<string, unknown>) => Answer) {
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
    "/audio/transcriptions",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const raw = yield* request.json.pipe(Effect.orElseSucceed(() => ({})))
      const body = typeof raw === "object" && raw !== null ? Object.fromEntries(Object.entries(raw)) : {}
      seen.push({ authorization: request.headers.authorization, body })
      const reply = answer(body)
      return HttpServerResponse.text(reply.body, { status: reply.status, contentType: "application/json" })
    }),
  )
  yield* server.serve(router.asHttpEffect())
  if (server.address._tag !== "TcpAddress") throw new Error("expected a TCP listener")
  yield* engineEnv(`http://127.0.0.1:${server.address.port}`)
  return { seen }
})

const transcript = (text: string) => ({
  status: 200,
  body: JSON.stringify({ text, seconds: 3.2, requestId: "req_1", costUsd: 0.0004 }),
})

const transcribe = (payload: Record<string, unknown>) =>
  HttpClientRequest.post(ControlPaths.transcribe).pipe(
    HttpClientRequest.bodyJson(payload),
    Effect.flatMap(HttpClient.execute),
  )

describe("redrob transcribe HttpApi", () => {
  it.live("answers with the gateway's transcript, sending the engine's key only to the gateway", () =>
    Effect.gen(function* () {
      const { seen } = yield* gateway(() => transcript("  회의 요약해 줘, and send it to Minji  "))
      const response = yield* transcribe({ audio: CLIP, format: "webm", language: "KO" })

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        text: "회의 요약해 줘, and send it to Minji",
        seconds: 3.2,
        costUsd: 0.0004,
      })
      expect(seen).toEqual([
        {
          authorization: "Bearer rk_engine_key",
          body: {
            model: DEFAULT_TRANSCRIPTION_MODEL,
            input_audio: { data: CLIP, format: "webm" },
            response_format: "json",
            language: "ko",
          },
        },
      ])
    }),
  )

  it.live("leaves the language to the gateway when none is given, and passes a chosen model through", () =>
    Effect.gen(function* () {
      const { seen } = yield* gateway(() => transcript("Hello"))
      const response = yield* transcribe({ audio: CLIP, format: "ogg", model: "openai/gpt-transcribe" })
      expect(response.status).toBe(200)
      expect(seen[0]?.body).toEqual({
        model: "openai/gpt-transcribe",
        input_audio: { data: CLIP, format: "ogg" },
        response_format: "json",
      })
    }),
  )

  it.live("refuses audio the gateway would refuse with a 400, sending nothing", () =>
    Effect.gen(function* () {
      const { seen } = yield* gateway(() => transcript("Hello"))
      /* The smallest unpadded base64 that decodes to more than the limit. */
      const oversize = "A".repeat(Math.ceil((MAX_TRANSCRIPTION_BYTES + 1) / 3) * 4)
      for (const payload of [
        { audio: "   ", format: "webm" },
        { audio: `data:audio/webm;base64,${CLIP}`, format: "webm" },
        { audio: "abc", format: "webm" },
        { audio: oversize, format: "webm" },
        { audio: CLIP, format: "webm", language: "korean" },
        { audio: CLIP, format: "opus" },
      ]) {
        expect((yield* transcribe(payload)).status).toBe(400)
      }
      expect(seen).toHaveLength(0)
    }),
  )

  it.live("without a Redrob key it is a 503, sending nothing", () =>
    Effect.gen(function* () {
      const { seen } = yield* gateway(() => transcript("Hello"))
      process.env.REDROB_AUTH_CONTENT = JSON.stringify({})
      const response = yield* transcribe({ audio: CLIP, format: "webm" })
      expect(response.status).toBe(503)
      expect(JSON.stringify(yield* response.json)).toContain("Connect Redrob")
      expect(seen).toHaveLength(0)
    }),
  )

  it.live("a gateway refusal, or an answer that is not a transcript, is a 502 with the gateway's message", () =>
    Effect.gen(function* () {
      yield* gateway((body) =>
        body.model === "shapeless"
          ? { status: 200, body: JSON.stringify({ transcript: "Hello" }) }
          : { status: 402, body: JSON.stringify({ error: { message: "Out of credit." } }) },
      )
      const refused = yield* transcribe({ audio: CLIP, format: "webm" })
      expect(refused.status).toBe(502)
      expect(JSON.stringify(yield* refused.json)).toContain("answered 402: Out of credit.")
      const shapeless = yield* transcribe({ audio: CLIP, format: "webm", model: "shapeless" })
      expect(shapeless.status).toBe(502)
      expect(JSON.stringify(yield* shapeless.json)).toContain("without a transcript")
    }),
  )
})
