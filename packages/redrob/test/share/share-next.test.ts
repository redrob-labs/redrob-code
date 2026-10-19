import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { httpClient } from "@redrob-code/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@redrob-code/core/cross-spawn-spawner"
import { SessionProjector } from "@redrob-code/core/session/projector"

import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Session } from "@/session/session"
import type { SessionID } from "../../src/session/schema"
import { ShareNext } from "@/share/share-next"
import { SessionShareTable } from "@redrob-code/core/share/sql"
import { Database } from "@redrob-code/core/database/database"
import { eq } from "drizzle-orm"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const env = LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node]))
const it = testEffect(env)

const json = (req: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const none = HttpClient.make(() => Effect.die("unexpected http call"))

function requestLayer(client: HttpClient.HttpClient) {
  const replacement = [httpClient, Layer.succeed(HttpClient.HttpClient, client)] as const
  return LayerNode.compile(LayerNode.group([ShareNext.node]), [replacement])
}

function integrationLayer(client: HttpClient.HttpClient) {
  const replacement = [httpClient, Layer.succeed(HttpClient.HttpClient, client)] as const
  return LayerNode.compile(
    LayerNode.group([ShareNext.node, EventV2Bridge.node, Session.node, SessionProjector.node, Database.node]),
    [replacement],
  )
}

const share = (id: SessionID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(SessionShareTable)
      .where(eq(SessionShareTable.session_id, id))
      .get()
      .pipe(Effect.orDie)
  })

const chat = { config: { chat: { url: "https://chat.example.com/" } } }
const previousKey = process.env["REDROB_API_KEY"]

beforeEach(async () => {
  await resetDatabase()
  process.env["REDROB_API_KEY"] = "rk_test_key"
})

afterEach(() => {
  if (previousKey === undefined) delete process.env["REDROB_API_KEY"]
  else process.env["REDROB_API_KEY"] = previousKey
})

describe("ShareNext", () => {
  it.live("request targets the Redrob Chat API with the console key", () =>
    provideTmpdirInstance(
      () =>
        ShareNext.Service.use((svc) =>
          Effect.gen(function* () {
            const req = yield* svc.request()

            expect(req.baseUrl).toBe("https://chat.example.com")
            expect(req.api.create).toBe("/share")
            expect(req.api.remove("shr_123")).toBe("/share/shr_123")
            expect(req.api.data("shr_123")).toBe("/share/shr_123")
            expect(req.headers).toEqual({ authorization: "Bearer rk_test_key" })
          }),
        ).pipe(Effect.provide(requestLayer(none))),
      chat,
    ),
  )

  it.live("request defaults to production Redrob Chat", () =>
    provideTmpdirInstance(() =>
      ShareNext.Service.use((svc) =>
        Effect.gen(function* () {
          const req = yield* svc.request()
          expect(req.baseUrl).toBe(ShareNext.DEFAULT_CHAT_API_URL)
        }),
      ).pipe(Effect.provide(requestLayer(none))),
    ),
  )

  it.live("create posts a transcript snapshot, persists it, and returns the result", () =>
    provideTmpdirInstance(
      () => {
        const seen: HttpClientRequest.HttpClientRequest[] = []
        const client = HttpClient.make((req) => {
          seen.push(req)
          return Effect.succeed(json(req, { id: "shr_abcdefghijklmnop", url: "https://chat.example.com/s/abc" }, 201))
        })
        return Effect.gen(function* () {
          const session = yield* (yield* Session.Service).create({ title: "test" })

          const result = yield* (yield* ShareNext.Service).create(session.id)

          expect(result.id).toBe("shr_abcdefghijklmnop")
          expect(result.url).toBe("https://chat.example.com/s/abc")

          const row = yield* share(session.id)
          expect(row?.url).toBe("https://chat.example.com/s/abc")

          expect(seen).toHaveLength(1)
          expect(seen[0].method).toBe("POST")
          expect(seen[0].url).toBe("https://chat.example.com/share")
          expect(seen[0].headers["authorization"]).toBe("Bearer rk_test_key")
          const body = seen[0].body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(seen[0].body.body)) : {}
          expect(body.kind).toBe("transcript")
          expect(body.source).toBe("code")
          expect(body.title).toBe("test")
          expect(Array.isArray(body.messages)).toBe(true)
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      chat,
    ),
  )

  it.live("remove deletes the persisted share and calls DELETE /share/:id", () =>
    provideTmpdirInstance(
      () => {
        const seen: HttpClientRequest.HttpClientRequest[] = []
        const client = HttpClient.make((req) => {
          seen.push(req)
          if (req.method === "POST") {
            return Effect.succeed(json(req, { id: "shr_abc", url: "https://chat.example.com/s/shr_abc" }, 201))
          }
          return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 204 })))
        })
        return Effect.gen(function* () {
          const session = yield* (yield* Session.Service).create({ title: "test" })
          const service = yield* ShareNext.Service

          yield* service.create(session.id)
          yield* service.remove(session.id)

          expect(yield* share(session.id)).toBeUndefined()
          expect(seen.map((req) => [req.method, req.url])).toEqual([
            ["POST", "https://chat.example.com/share"],
            ["DELETE", "https://chat.example.com/share/shr_abc"],
          ])
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      chat,
    ),
  )

  it.live("create fails on a non-ok response and does not persist a share", () =>
    provideTmpdirInstance(() => {
      const client = HttpClient.make((req) => Effect.succeed(json(req, { error: "bad" }, 500)))
      return Effect.gen(function* () {
        const session = yield* (yield* Session.Service).create({ title: "test" })

        const exit = yield* ShareNext.Service.use((svc) => Effect.exit(svc.create(session.id)))

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* share(session.id)).toBeUndefined()
      }).pipe(Effect.provide(integrationLayer(client)))
    }, chat),
  )
})
