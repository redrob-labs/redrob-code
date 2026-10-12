/**
 * Route tests for `POST /v1/chat/completions`, driven in-process against the real
 * app through `httpapi-layer`.
 *
 * Scope note. These tests cover what can be asserted without a provider
 * credential: that the route is served on the v2 surface at all, that a body
 * decodes against `ChatCompletionRequest`, that every failure comes back in the
 * OpenAI error envelope rather than Effect's default shape, and that the v1
 * contract's field names are actually present. A completion that reaches a model
 * needs a credential this suite has none of, so the streaming happy path is
 * covered by `chat-completion-wire.test.ts` at the conversion layer instead of
 * being faked here.
 *
 * The envelope assertions are the point. A caller written against OpenAI's API
 * reads `error.message` and `error.type`; if this route ever returns Effect's
 * `{ name, data }` shape instead, every such caller silently sees an
 * error-less response and reports a truncated or empty answer rather than a
 * failure.
 */
import { describe, expect } from "bun:test"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Session } from "@/session/session"
import { Database } from "@redrob-code/core/database/database"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([Session.node, Database.node])), httpApiLayer))

const PATH = "/v1/chat/completions"

function post(directory: string, body: unknown) {
  return requestInDirectory(PATH, directory, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

type ErrorEnvelope = {
  error?: { message?: unknown; type?: unknown; code?: unknown; param?: unknown }
}

describe("POST /v1/chat/completions", () => {
  it.instance("is served on the v2 surface", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* post(tmp.directory, {
        model: "no-such-provider/no-such-model",
        messages: [{ role: "user", content: "ping" }],
      })

      // Any status other than 404 proves the route exists and is reached. The
      // specific failure is asserted below; this case exists so a registration
      // regression (the group dropped from protocol/src/api.ts) fails loudly and
      // separately from a behaviour change.
      expect(response.status).not.toBe(404)
    }),
  )

  it.instance("reports an unknown model in the OpenAI error envelope", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* post(tmp.directory, {
        model: "no-such-provider/no-such-model",
        messages: [{ role: "user", content: "ping" }],
      })

      expect(response.status).toBe(400)
      const body = yield* json<ErrorEnvelope>(response)
      expect(typeof body.error).toBe("object")
      expect(typeof body.error?.message).toBe("string")
      expect(typeof body.error?.type).toBe("string")
      // Effect's default failure shape must NOT leak through.
      expect(body).not.toHaveProperty("name")
      expect(body).not.toHaveProperty("data")
    }),
  )

  it.instance("rejects a body that is not a chat-completions request", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* post(tmp.directory, { model: "x" })

      expect(response.status).toBe(400)
      const body = yield* json<ErrorEnvelope>(response)
      expect(typeof body.error?.message).toBe("string")
    }),
  )

  it.instance("rejects an empty message list rather than calling a provider", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* post(tmp.directory, { model: "x/y", messages: [] })

      expect(response.status).toBe(400)
    }),
  )

  // v1 CONTRACT. This is the test that should fail when someone removes or renames
  // a field downstream callers read. It asserts the request shape is still
  // ACCEPTED (decode succeeds, so the failure is about the model rather than the
  // body) for every field the v1 contract promises, including the tools path that
  // `docs/LOCAL-ENGINE-API.md` describes as caller-owned.
  it.instance("still accepts every field the v1 contract promises", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* post(tmp.directory, {
        model: "no-such-provider/no-such-model",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "ping" },
          { role: "assistant", content: "pong" },
        ],
        stream: true,
        temperature: 0.2,
        max_tokens: 64,
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Look up the weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
        tool_choice: "auto",
      })

      // 400 for the unknown model, NOT a decode failure: if a promised field had
      // been dropped from the schema this would still be 400 but with a decode
      // message, so the body is checked for the model rather than the shape.
      expect(response.status).toBe(400)
      const body = yield* json<ErrorEnvelope>(response)
      const message = String(body.error?.message ?? "")
      expect(message.toLowerCase()).not.toContain("expected")
      expect(message.toLowerCase()).not.toContain("is missing")
    }),
  )

  // v1 CONTRACT, the newer-but-promised fields. `max_completion_tokens`,
  // `reasoning_effort` and `user` are in the documented request and must stay
  // ACCEPTED; same 400-for-the-model, not-a-decode-error technique as above.
  it.instance("accepts the newer optional fields (max_completion_tokens, reasoning_effort, user)", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* post(tmp.directory, {
        model: "no-such-provider/no-such-model",
        messages: [{ role: "user", content: "ping" }],
        max_completion_tokens: 64,
        reasoning_effort: "low",
        user: "someone",
      })

      expect(response.status).toBe(400)
      const body = yield* json<ErrorEnvelope>(response)
      const message = String(body.error?.message ?? "")
      expect(message.toLowerCase()).not.toContain("expected")
      expect(message.toLowerCase()).not.toContain("is missing")
    }),
  )

  // BACKWARDS / FORWARD COMPATIBILITY. The engine's request is an OpenAI subset;
  // unknown fields are ignored, not rejected, so a stock OpenAI SDK and a newer
  // client both talk to it without a version check. This pins that promise: a
  // request carrying fields the schema does not name (a Console-style `redrob`
  // block a client may add, and an outright bogus key) is still ACCEPTED — the
  // failure is the unknown model, never a decode rejection of the extra fields.
  // If someone makes the schema reject excess properties, this fails and names
  // the regression. (See docs/LOCAL-ENGINE-API.md and docs/ON-DEVICE-LABELLING.md.)
  it.instance("ignores unknown request fields rather than rejecting them", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* post(tmp.directory, {
        model: "no-such-provider/no-such-model",
        messages: [{ role: "user", content: "ping" }],
        redrob: { route: { profession: "lawyer", task: "review" } },
        not_a_real_field: 123,
      })

      // Accepted and decoded (unknown fields dropped), so we reach the model and
      // get the unknown-model 400 — NOT a 400 complaining about the extra fields.
      expect(response.status).toBe(400)
      const body = yield* json<ErrorEnvelope>(response)
      const message = String(body.error?.message ?? "")
      expect(message.toLowerCase()).not.toContain("redrob")
      expect(message.toLowerCase()).not.toContain("not_a_real_field")
      expect(message.toLowerCase()).not.toContain("unexpected")
    }),
  )
})
