import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { Database } from "@redrob-code/core/database/database"
import { RoutineTable, type RoutineTriggerData } from "@redrob-code/core/routine/sql"
import { Routine as RoutineSchema } from "@redrob-code/schema/routine"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm"
import { Context, Cron, Effect, Layer, Result, Schema } from "effect"
import os from "node:os"
import { RoutineMarker } from "./marker"
import { RoutineWatch } from "./watch"

/**
 * Durable routines: one row per routine, in the shared database, with an event on every change.
 *
 * This is the only writer of the `routine` table. The engine (./engine) runs routines and the
 * HTTP API and the `routine` tool change them, all through here, so every change publishes
 * `routine.updated` exactly once and a phone listening for it sees the same state the engine acts on.
 *
 * Kept free of the session prompt on purpose: the `routine` tool lives in the tool registry, which
 * the prompt depends on, so a store that depended on the prompt would close a cycle.
 */

export const ID = RoutineSchema.ID
export type ID = RoutineSchema.ID
export const Info = RoutineSchema.Info
export type Info = RoutineSchema.Info
export type Trigger = RoutineSchema.Trigger
export type Status = RoutineSchema.Status
export const Event = RoutineSchema.Event

/** Seconds. Anything faster is a busy loop with a model on the other end. */
export const MIN_INTERVAL = 60
export const DEFAULT_WATCH_INTERVAL = 300

/** How long a claim on a routine holds without renewal. */
export const LEASE_MS = 30_000

/** This process, as written into `owner`. Unique per start so a restarted pid is a new owner. */
export const OWNER = `${os.hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 10)}`

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Routine.NotFoundError", {
  id: Schema.String,
}) {
  override get message() {
    return `Routine not found: ${this.id}`
  }
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("Routine.InvalidError", {
  message: Schema.String,
}) {}

export interface CreateInput {
  readonly sessionID: SessionID
  readonly directory: string
  readonly goal: string
  readonly trigger: Trigger
  readonly maxCycles?: number
}

/** What the engine writes after a cycle. Absent fields keep their stored value. */
export interface Patch {
  readonly status?: Status
  readonly cycles?: number
  readonly ledger?: RoutineMarker.Ledger
  readonly fingerprint?: string | null
  readonly reason?: string | null
}

/** A row the engine may run, with what it needs that the public Info does not carry. */
export interface Runnable {
  readonly info: Info
  readonly directory: string
  readonly ledger: RoutineMarker.Ledger
  readonly fingerprint: string | undefined
}

export interface Interface {
  readonly list: (input?: { readonly sessionID?: SessionID }) => Effect.Effect<readonly Info[]>
  readonly get: (id: ID) => Effect.Effect<Info, NotFoundError>
  readonly create: (input: CreateInput) => Effect.Effect<Info, InvalidError>
  /** The one way to end a routine, whatever wakes it. */
  readonly stop: (id: ID, reason?: string) => Effect.Effect<Info, NotFoundError>
  readonly pause: (id: ID) => Effect.Effect<Info, NotFoundError | InvalidError>
  readonly resume: (id: ID) => Effect.Effect<Info, NotFoundError | InvalidError>

  /** Engine only. Undefined when the row is gone (its session was deleted). */
  readonly runnable: (id: ID) => Effect.Effect<Runnable | undefined>
  readonly record: (id: ID, patch: Patch) => Effect.Effect<Info | undefined>
  /** Takes or renews this process's lease. False when another live owner holds it or it is not running. */
  readonly claim: (id: ID) => Effect.Effect<boolean>
  readonly release: (id: ID) => Effect.Effect<void>
  /** Running routines no live process holds. */
  readonly orphans: () => Effect.Effect<readonly Runnable[]>
}

export class Service extends Context.Service<Service, Interface>()("@redrob/Routine") {}

type Row = typeof RoutineTable.$inferSelect

const toTrigger = (data: RoutineTriggerData): Trigger => {
  if (data.type === "after_turn") return { type: "after_turn" }
  if (data.type === "schedule") {
    return {
      type: "schedule",
      ...(data.cron !== undefined ? { cron: data.cron } : {}),
      ...(data.every !== undefined ? { every: data.every } : {}),
      ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
    }
  }
  return { type: "watch", kind: data.kind, url: data.url, interval: data.interval }
}

const toInfo = (row: Row): Info => ({
  id: ID.make(row.id),
  sessionID: SessionID.make(row.session_id),
  goal: row.goal,
  trigger: toTrigger(row.trigger),
  status: row.status as Status,
  cycles: row.cycles,
  maxCycles: row.max_cycles,
  rejected: [...row.ledger.rejected],
  ...(row.reason ? { reason: row.reason } : {}),
  time: { created: row.time_created, updated: row.time_updated },
})

const toRunnable = (row: Row): Runnable => ({
  info: toInfo(row),
  directory: row.directory,
  ledger: { rejected: [...row.ledger.rejected], recentNext: [...row.ledger.recentNext] },
  fingerprint: row.fingerprint ?? undefined,
})

/** PURE. Normalises and checks a trigger before it is stored. */
export function normalizeTrigger(trigger: Trigger): Result.Result<RoutineTriggerData, string> {
  if (trigger.type === "after_turn") return Result.succeed({ type: "after_turn" })
  if (trigger.type === "schedule") {
    const hasCron = trigger.cron !== undefined && trigger.cron.trim().length > 0
    const hasEvery = trigger.every !== undefined
    if (hasCron === hasEvery) return Result.fail("A schedule needs exactly one of cron and every.")
    if (hasEvery) {
      if (trigger.every! < MIN_INTERVAL) return Result.fail(`every must be at least ${MIN_INTERVAL} seconds.`)
      return Result.succeed({ type: "schedule", every: trigger.every! })
    }
    const cron = trigger.cron!.trim()
    const parsed = Cron.parse(cron, trigger.timezone)
    if (Result.isFailure(parsed)) return Result.fail(`Invalid cron expression or time zone: ${parsed.failure.message}`)
    return Result.succeed({
      type: "schedule",
      cron,
      ...(trigger.timezone ? { timezone: trigger.timezone } : {}),
    })
  }
  const url = trigger.url.trim().replace(/\/$/, "")
  if (!RoutineWatch.isPullRequestUrl(url)) return Result.fail("watch needs a full GitHub pull request URL.")
  const interval = trigger.interval ?? DEFAULT_WATCH_INTERVAL
  if (interval < MIN_INTERVAL) return Result.fail(`interval must be at least ${MIN_INTERVAL} seconds.`)
  return Result.succeed({ type: "watch", kind: "github_pr", url, interval })
}

const ACTIVE: Status[] = ["running", "paused"]

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2Bridge.Service

    const row = (id: ID) =>
      db.select().from(RoutineTable).where(eq(RoutineTable.id, id)).get().pipe(Effect.orDie)

    const publish = (info: Info) => events.publish(Event.Updated, { info }).pipe(Effect.asVoid)

    const write = Effect.fn("Routine.write")(function* (id: ID, set: Partial<typeof RoutineTable.$inferInsert>) {
      const updated = yield* db
        .update(RoutineTable)
        .set({ ...set, time_updated: Date.now() })
        .where(eq(RoutineTable.id, id))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!updated) return undefined
      const info = toInfo(updated)
      yield* publish(info)
      return info
    })

    const require = Effect.fn("Routine.require")(function* (id: ID) {
      const found = yield* row(id)
      if (!found) return yield* new NotFoundError({ id })
      return found
    })

    const list: Interface["list"] = Effect.fn("Routine.list")(function* (input) {
      const rows = yield* db
        .select()
        .from(RoutineTable)
        .where(input?.sessionID ? eq(RoutineTable.session_id, input.sessionID) : undefined)
        .orderBy(RoutineTable.time_created)
        .all()
        .pipe(Effect.orDie)
      return rows.map(toInfo)
    })

    const get: Interface["get"] = Effect.fn("Routine.get")(function* (id) {
      return toInfo(yield* require(id))
    })

    const create: Interface["create"] = Effect.fn("Routine.create")(function* (input) {
      const goal = input.goal.trim()
      if (goal.length === 0) return yield* new InvalidError({ message: "A routine needs a goal." })
      const trigger = normalizeTrigger(input.trigger)
      if (Result.isFailure(trigger)) return yield* new InvalidError({ message: trigger.failure })

      // Two autopilots in one session would answer each other's turns. Schedules and watches
      // only wake on their own clock, so any number of them may share a session.
      if (trigger.success.type === "after_turn") {
        const existing = yield* db
          .select({ id: RoutineTable.id, trigger: RoutineTable.trigger })
          .from(RoutineTable)
          .where(and(eq(RoutineTable.session_id, input.sessionID), inArray(RoutineTable.status, ACTIVE)))
          .all()
          .pipe(Effect.orDie)
        const autopilot = existing.find((item) => item.trigger.type === "after_turn")
        if (autopilot) {
          return yield* new InvalidError({ message: `This session already has an autopilot: ${autopilot.id}` })
        }
      }

      const now = Date.now()
      const inserted = yield* db
        .insert(RoutineTable)
        .values({
          id: ID.create(),
          session_id: input.sessionID,
          directory: input.directory,
          goal,
          trigger: trigger.success,
          status: "running",
          max_cycles: input.maxCycles ?? RoutineMarker.DEFAULT_MAX_CYCLES,
          cycles: 0,
          ledger: RoutineMarker.emptyLedger(),
          // Claimed by its creator from the first moment, so no other process's sweep mistakes a
          // routine that is about to start for one whose owner died.
          owner: OWNER,
          lease: now + LEASE_MS,
          time_created: now,
          time_updated: now,
        })
        .returning()
        .get()
        .pipe(Effect.orDie)
      const info = toInfo(inserted!)
      yield* publish(info)
      return info
    })

    const stop: Interface["stop"] = Effect.fn("Routine.stop")(function* (id, reason) {
      const found = yield* require(id)
      if (!ACTIVE.includes(found.status as Status)) return toInfo(found)
      const info = yield* write(id, { status: "stopped", reason: reason ?? null, owner: null, lease: null })
      return info ?? toInfo(found)
    })

    const pause: Interface["pause"] = Effect.fn("Routine.pause")(function* (id) {
      const found = yield* require(id)
      if (found.status === "paused") return toInfo(found)
      if (found.status !== "running") {
        return yield* new InvalidError({ message: `Only a running routine can be paused; this one is ${found.status}.` })
      }
      const info = yield* write(id, { status: "paused", reason: null, owner: null, lease: null })
      return info ?? toInfo(found)
    })

    const resume: Interface["resume"] = Effect.fn("Routine.resume")(function* (id) {
      const found = yield* require(id)
      if (found.status === "running") return toInfo(found)
      if (found.status !== "paused" && found.status !== "blocked") {
        return yield* new InvalidError({ message: `A ${found.status} routine cannot be resumed; create a new one.` })
      }
      const info = yield* write(id, {
        status: "running",
        reason: null,
        // A stall is about one run's circling, so plans do not carry over; dead ends do.
        ledger: { rejected: found.ledger.rejected, recentNext: [] },
        // A routine that ran out of cycles gets a fresh allowance, or resuming would end it at once.
        cycles: found.cycles >= found.max_cycles ? 0 : found.cycles,
        owner: OWNER,
        lease: Date.now() + LEASE_MS,
      })
      return info ?? toInfo(found)
    })

    const runnable: Interface["runnable"] = Effect.fn("Routine.runnable")(function* (id) {
      const found = yield* row(id)
      return found ? toRunnable(found) : undefined
    })

    const record: Interface["record"] = Effect.fn("Routine.record")(function* (id, patch) {
      const terminal = patch.status !== undefined && patch.status !== "running"
      return yield* write(id, {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.cycles !== undefined ? { cycles: patch.cycles } : {}),
        ...(patch.ledger !== undefined ? { ledger: patch.ledger } : {}),
        ...(patch.fingerprint !== undefined ? { fingerprint: patch.fingerprint } : {}),
        ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
        ...(terminal ? { owner: null, lease: null } : {}),
      })
    })

    const claim: Interface["claim"] = Effect.fn("Routine.claim")(function* (id) {
      const now = Date.now()
      // Not through `write`: a lease renewal is bookkeeping, not a change anyone needs to hear about.
      const claimed = yield* db
        .update(RoutineTable)
        .set({ owner: OWNER, lease: now + LEASE_MS })
        .where(
          and(
            eq(RoutineTable.id, id),
            eq(RoutineTable.status, "running"),
            or(isNull(RoutineTable.owner), eq(RoutineTable.owner, OWNER), lt(RoutineTable.lease, now)),
          ),
        )
        .returning({ id: RoutineTable.id })
        .get()
        .pipe(Effect.orDie)
      return claimed !== undefined
    })

    const release: Interface["release"] = Effect.fn("Routine.release")(function* (id) {
      yield* db
        .update(RoutineTable)
        .set({ owner: null, lease: null })
        .where(and(eq(RoutineTable.id, id), eq(RoutineTable.owner, OWNER)))
        .run()
        .pipe(Effect.orDie)
    })

    const orphans: Interface["orphans"] = Effect.fn("Routine.orphans")(function* () {
      const rows = yield* db
        .select()
        .from(RoutineTable)
        .where(
          and(eq(RoutineTable.status, "running"), or(isNull(RoutineTable.owner), lt(RoutineTable.lease, Date.now()))),
        )
        .all()
        .pipe(Effect.orDie)
      return rows.map(toRunnable)
    })

    return Service.of({ list, get, create, stop, pause, resume, runnable, record, claim, release, orphans })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: () => [Database.node, EventV2Bridge.node] })

export * as Routine from "./store"
