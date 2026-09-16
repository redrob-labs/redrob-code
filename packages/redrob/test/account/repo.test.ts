import { expect } from "bun:test"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { Effect, Layer, Option } from "effect"
import { sql } from "drizzle-orm"

import { AccountRepo } from "../../src/account/repo"
import { AccessToken, AccountID, OrgID } from "../../src/account/schema"
import { Database } from "@redrob-code/core/database/database"
import { testEffect } from "../lib/effect"

const truncate = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(sql`DELETE FROM account_state`)
    yield* db.run(sql`DELETE FROM account`)
  }),
)
const truncateNode = LayerNode.make({ name: "truncate-account", layer: truncate, deps: () => [Database.node] })

const it = testEffect(LayerNode.compile(LayerNode.group([AccountRepo.node, truncateNode])))

it.live("list returns empty when no accounts exist", () =>
  Effect.gen(function* () {
    const accounts = yield* AccountRepo.use.list()
    expect(accounts).toEqual([])
  }),
)

it.live("active returns none when no accounts exist", () =>
  Effect.gen(function* () {
    const active = yield* AccountRepo.use.active()
    expect(Option.isNone(active)).toBe(true)
  }),
)

it.live("persistAccount inserts and getRow retrieves", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("sk_123"),
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )

    const row = yield* AccountRepo.use.getRow(id)
    expect(Option.isSome(row)).toBe(true)
    const value = Option.getOrThrow(row)
    expect(value.id).toBe(AccountID.make("user-1"))
    expect(value.email).toBe("test@example.com")
    expect(String(value.access_token)).toBe("sk_123")
    // The API key is mirrored into refresh_token (NOT NULL column) and never expires.
    expect(String(value.refresh_token)).toBe("sk_123")
    expect(value.token_expiry).toBeNull()

    const active = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active).active_org_id).toBe(OrgID.make("org-1"))
  }),
)

it.live("persistAccount normalizes trailing slashes in stored server URLs", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com/",
        accessToken: AccessToken.make("sk_123"),
        orgID: Option.none(),
      }),
    )

    const row = yield* AccountRepo.use.getRow(id)
    const active = yield* AccountRepo.use.active()
    const list = yield* AccountRepo.use.list()

    expect(Option.getOrThrow(row).url).toBe("https://control.example.com")
    expect(Option.getOrThrow(active).url).toBe("https://control.example.com")
    expect(list[0]?.url).toBe("https://control.example.com")
  }),
)

it.live("persistAccount sets the active account and org", () =>
  Effect.gen(function* () {
    const id1 = AccountID.make("user-1")
    const id2 = AccountID.make("user-2")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: id1,
        email: "first@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("sk_1"),
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: id2,
        email: "second@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("sk_2"),
        orgID: Option.some(OrgID.make("org-2")),
      }),
    )

    // Last persisted account is active with its org
    const active = yield* AccountRepo.use.active()
    expect(Option.isSome(active)).toBe(true)
    expect(Option.getOrThrow(active).id).toBe(AccountID.make("user-2"))
    expect(Option.getOrThrow(active).active_org_id).toBe(OrgID.make("org-2"))
  }),
)

it.live("list returns all accounts", () =>
  Effect.gen(function* () {
    const id1 = AccountID.make("user-1")
    const id2 = AccountID.make("user-2")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: id1,
        email: "a@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("sk_1"),
        orgID: Option.none(),
      }),
    )

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: id2,
        email: "b@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("sk_2"),
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )

    const accounts = yield* AccountRepo.use.list()
    expect(accounts.length).toBe(2)
    expect(accounts.map((a) => a.email).sort()).toEqual(["a@example.com", "b@example.com"])
  }),
)

it.live("remove deletes an account", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("sk_1"),
        orgID: Option.none(),
      }),
    )

    yield* AccountRepo.use.remove(id)

    const row = yield* AccountRepo.use.getRow(id)
    expect(Option.isNone(row)).toBe(true)
  }),
)

it.live("use stores the selected org and marks the account active", () =>
  Effect.gen(function* () {
    const id1 = AccountID.make("user-1")
    const id2 = AccountID.make("user-2")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: id1,
        email: "first@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("sk_1"),
        orgID: Option.none(),
      }),
    )

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: id2,
        email: "second@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("sk_2"),
        orgID: Option.none(),
      }),
    )

    yield* AccountRepo.Service.use((r) => r.use(id1, Option.some(OrgID.make("org-99"))))
    const active1 = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active1).id).toBe(id1)
    expect(Option.getOrThrow(active1).active_org_id).toBe(OrgID.make("org-99"))

    yield* AccountRepo.Service.use((r) => r.use(id1, Option.none()))
    const active2 = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active2).active_org_id).toBeNull()
  }),
)

it.live("persistAccount upserts on conflict", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("sk_v1"),
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("sk_v2"),
        orgID: Option.some(OrgID.make("org-2")),
      }),
    )

    const accounts = yield* AccountRepo.use.list()
    expect(accounts.length).toBe(1)

    const row = yield* AccountRepo.use.getRow(id)
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe(AccessToken.make("sk_v2"))

    const active = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active).active_org_id).toBe(OrgID.make("org-2"))
  }),
)

it.live("remove clears active state when deleting the active account", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("sk_1"),
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )

    yield* AccountRepo.use.remove(id)

    const active = yield* AccountRepo.use.active()
    expect(Option.isNone(active)).toBe(true)
  }),
)

it.live("getRow returns none for nonexistent account", () =>
  Effect.gen(function* () {
    const row = yield* AccountRepo.Service.use((r) => r.getRow(AccountID.make("nope")))
    expect(Option.isNone(row)).toBe(true)
  }),
)
