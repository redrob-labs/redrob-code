export * as Database from "./database"

import { EffectDrizzleSqlite } from "@redrob-code/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@redrob/v2/storage/Database") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

export function path() {
  if (Flag.REDROB_DB) {
    if (Flag.REDROB_DB === ":memory:" || isAbsolute(Flag.REDROB_DB)) return Flag.REDROB_DB
    return join(Global.Path.data, Flag.REDROB_DB)
  }
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.REDROB_DISABLE_CHANNEL_DB === "1" ||
    process.env.REDROB_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, "redrob.db")
  return join(Global.Path.data, `redrob-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

// The filename is resolved when the layer is built rather than when this module is
// imported. Reading it at import time pinned every host in the process to whatever
// `Flag.REDROB_DB` said when core first loaded, so a second embedded host could not point
// at its own database file.
export const node = makeGlobalNode({ service: Service, layer: Layer.suspend(() => layerFromPath(path())), deps: () => [] })
