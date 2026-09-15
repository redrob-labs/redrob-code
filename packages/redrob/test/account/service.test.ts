import { expect } from "bun:test"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { httpClient } from "@redrob-code/core/effect/app-node-platform"
import { Effect, Layer, Option } from "effect"
import { sql } from "drizzle-orm"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http"

import { AccountRepo } from "../../src/account/repo"
import { Account } from "../../src/account/account"
import { AccessToken, AccountID, AccountServiceError, AccountTransportError } from "../../src/account/schema"
import { Database } from "@redrob-code/core/database/database"
import { testEffect } from "../lib/effect"

const truncate = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(sql`DELETE FROM account_state`)
    yield* db.run(sql`DELETE FROM account`)
  }),
)
const truncateNode = LayerNode.make({ name: "truncate-account", layer: truncate, deps: [Database.node] })

const it = testEffect(LayerNode.compile(LayerNode.group([AccountRepo.node, truncateNode])))

const live = (client: HttpClient.HttpClient) =>
  LayerNode.compile(Account.node, [[httpClient, Layer.succeed(HttpClient.HttpClient, client)]])

const json = (req: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

// The real console.redrob.ai API validates the key via the OpenAI-compatible models endpoint.
const modelsBody = { object: "list", data: [{ id: "auto", object: "model" }] }

it.live("login validates the api key against the models endpoint and persists the account", () =>
  Effect.gen(function* () {
    const seen: Array<string> = []
    const client = HttpClient.make((req) =>
      Effect.gen(function* () {
        seen.push(`${req.method} ${req.url} auth=${req.headers.authorization}`)

        if (req.url === "https://one.example.com/api/backend/v1/models") {
          return json(req, modelsBody)
        }

        return json(req, {}, 404)
      }),
    )

    const result = yield* Account.use
      .login("https://one.example.com", "rrk_abc123_secret")
      .pipe(Effect.provide(live(client)))

    expect(result.account.email).toBe("one.example.com")
    expect(result.orgs).toEqual([])
    expect(seen).toEqual(["GET https://one.example.com/api/backend/v1/models auth=Bearer rrk_abc123_secret"])

    const active = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active)).toEqual(
      expect.objectContaining({
        id: "redrob:rrk_abc123",
        url: "https://one.example.com",
        active_org_id: null,
      }),
    )

    const row = yield* AccountRepo.use.getRow(AccountID.make("redrob:rrk_abc123"))
    expect(String(Option.getOrThrow(row).access_token)).toBe("rrk_abc123_secret")
  }),
)

it.live("login normalizes base-path server URLs before calling the console", () =>
  Effect.gen(function* () {
    const seen: Array<string> = []
    const client = HttpClient.make((req) =>
      Effect.gen(function* () {
        seen.push(`${req.method} ${req.url}`)

        if (req.url === "https://one.example.com/console/api/backend/v1/models") {
          return json(req, modelsBody)
        }

        return json(req, {}, 404)
      }),
    )

    const result = yield* Account.use
      .login("https://one.example.com/console/", "rrk_abc123_secret")
      .pipe(Effect.provide(live(client)))

    expect(result.account.url).toBe("https://one.example.com/console")
    expect(seen).toEqual(["GET https://one.example.com/console/api/backend/v1/models"])
  }),
)

it.live("login maps transport failures to account transport errors", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((req) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request: req }),
        }),
      ),
    )

    const error = yield* Effect.flip(
      Account.use.login("https://one.example.com", "rrk_abc123_secret").pipe(Effect.provide(live(client))),
    )

    expect(error).toBeInstanceOf(AccountTransportError)
  }),
)

it.live("login fails with a service error when the api key is rejected", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((req) =>
      Effect.succeed(req.url === "https://one.example.com/api/backend/v1/models" ? json(req, {}, 401) : json(req, {})),
    )

    const error = yield* Effect.flip(
      Account.use.login("https://one.example.com", "bad_key").pipe(Effect.provide(live(client))),
    )

    expect(error).toBeInstanceOf(AccountServiceError)
  }),
)

it.live("token returns the stored api key without contacting the server", () =>
  Effect.gen(function* () {
    const id = AccountID.make("redrob:rrk_abc123")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "one.example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("rrk_abc123_secret"),
        orgID: Option.none(),
      }),
    )

    const client = HttpClient.make((req) => Effect.succeed(json(req, {}, 404)))

    const token = yield* Account.use.token(id).pipe(Effect.provide(live(client)))
    expect(String(Option.getOrThrow(token))).toBe("rrk_abc123_secret")
  }),
)

it.live("orgsByAccount returns each account with an empty org list", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: AccountID.make("redrob:rrk_one"),
        email: "one.example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("rrk_one_secret"),
        orgID: Option.none(),
      }),
    )

    const client = HttpClient.make((req) => Effect.succeed(json(req, {}, 404)))

    const rows = yield* Account.use.orgsByAccount().pipe(Effect.provide(live(client)))

    expect(rows.map((row) => [row.account.id, row.orgs])).toEqual([[AccountID.make("redrob:rrk_one"), []]])
  }),
)
