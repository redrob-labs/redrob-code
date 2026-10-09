import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Credential } from "@redrob-code/core/credential"
import { AppNodeBuilder } from "@redrob-code/core/effect/app-node-builder"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { EventV2 } from "@redrob-code/core/event"
import { Insights } from "@redrob-code/core/insights"
import { Integration } from "@redrob-code/core/integration"
import { testEffect } from "./lib/effect"

/**
 * Sending an app's labeled sessions with the key this engine holds.
 *
 * The console is a stand-in HttpClient that records what it was sent, so these assert the custody rule
 * directly: the key goes in the Authorization header of a request to the console's fixed insights URL,
 * and appears nowhere in what the caller gets back.
 */
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventV2.node])))

const KEY = "rrk_test_engine_held"
const SESSION = { externalId: "of_0123", startedAt: "2026-10-08T02:42:00Z", toolKey: "office", mode: 2 }

type Seen = { url: string; authorization: string | undefined; body: unknown }

function fakeConsole(status: number, body: unknown, seen: Seen[]) {
  return HttpClient.make((request) =>
    Effect.gen(function* () {
      const sent = request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : null
      seen.push({ url: request.url, authorization: request.headers["authorization"], body: sent })
      return HttpClientResponse.fromWeb(request, Response.json(body, { status }))
    }),
  )
}

const connectRedrob = Effect.gen(function* () {
  const integrations = yield* Integration.Service
  const integrationID = Integration.ID.make("redrob")
  yield* integrations.transform((editor) =>
    editor.method.update({ integrationID, method: { type: "key", label: "Redrob API key" } }),
  )
  yield* integrations.connection.key({ integrationID, key: KEY, label: "Redrob" })
})

describe("Insights", () => {
  it.effect("posts the batch to the console's insights with the stored key, and returns only the counts", () =>
    Effect.gen(function* () {
      yield* connectRedrob
      const seen: Seen[] = []
      const result = yield* Insights.send({ sessions: [SESSION] }).pipe(
        Effect.provideService(HttpClient.HttpClient, fakeConsole(200, { accepted: 1, updated: 0, rejected: [] }, seen)),
      )
      expect(result).toEqual({ accepted: 1, updated: 0, rejected: [] })
      expect(seen).toEqual([
        {
          url: "https://console.redrob.ai/api/backend/v1/insights/sessions",
          authorization: `Bearer ${KEY}`,
          body: { sessions: [SESSION] },
        },
      ])
      expect(JSON.stringify(result)).not.toContain(KEY)
    }),
  )

  it.effect("passes the console's per-session rejections through", () =>
    Effect.gen(function* () {
      yield* connectRedrob
      const rejected = [{ externalId: "of_0123", reason: "taskKey is not a task of actionKey" }]
      const result = yield* Insights.send({ sessions: [SESSION] }).pipe(
        Effect.provideService(HttpClient.HttpClient, fakeConsole(200, { accepted: 0, updated: 0, rejected }, [])),
      )
      expect(result.rejected).toEqual(rejected)
    }),
  )

  it.effect("refuses without a key, and never calls the console", () =>
    Effect.gen(function* () {
      const seen: Seen[] = []
      const exit = yield* Insights.send({ sessions: [SESSION] }).pipe(
        Effect.provideService(HttpClient.HttpClient, fakeConsole(200, {}, seen)),
        Effect.exit,
      )
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("not connected")
      expect(seen).toEqual([])
    }),
  )

  it.effect("carries the console's refusal and its message, NestJS list form included", () =>
    Effect.gen(function* () {
      yield* connectRedrob
      const exit = yield* Insights.send({ sessions: [SESSION] }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          fakeConsole(
            400,
            { statusCode: 400, message: ["sessions.0.summary is not a field"], error: "Bad Request" },
            [],
          ),
        ),
        Effect.flip,
      )
      expect(exit).toBeInstanceOf(Insights.Refused)
      if (!(exit instanceof Insights.Refused)) return
      expect([exit.status, exit.message]).toEqual([400, "sessions.0.summary is not a field"])
    }),
  )
})
