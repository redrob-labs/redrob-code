import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"

/** What wakes a routine. Stored as JSON; the engine in packages/redrob owns its meaning. */
export type RoutineTriggerData =
  | { readonly type: "after_turn" }
  | {
      readonly type: "schedule"
      /** 5- or 6-field cron expression. Exactly one of `cron` and `every` is set. */
      readonly cron?: string
      /** Interval in seconds. */
      readonly every?: number
      /** IANA time zone the cron expression is read in. */
      readonly timezone?: string
    }
  | {
      readonly type: "watch"
      readonly kind: "github_pr"
      /** Full pull request URL. */
      readonly url: string
      /** Seconds between polls. */
      readonly interval: number
    }

export type RoutineLedgerData = {
  /** Approaches the model reported as failed, so later cycles do not re-walk them. */
  readonly rejected: string[]
  /** The most recent plans, newest last. Only read to notice repetition. */
  readonly recentNext: string[]
}

export const RoutineTable = sqliteTable(
  "routine",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    /** The instance directory the routine runs in, so a restart re-arms it in the right place. */
    directory: text().notNull(),
    goal: text().notNull(),
    trigger: text({ mode: "json" }).notNull().$type<RoutineTriggerData>(),
    status: text().notNull(),
    max_cycles: integer().notNull(),
    cycles: integer().notNull(),
    ledger: text({ mode: "json" }).notNull().$type<RoutineLedgerData>(),
    /** Last observed state of a watched subject. A wake happens only when this changes. */
    fingerprint: text(),
    /** Why the routine stopped or paused, in words a person can read. */
    reason: text(),
    /**
     * The process running it and until when that claim holds. The daemon and a terminal's own
     * server share one database, so a routine runs only in the process holding an unexpired lease.
     * A process that dies stops renewing it, and the next one to sweep re-arms the routine.
     */
    owner: text(),
    lease: integer(),
    ...Timestamps,
  },
  (table) => [index("routine_session_idx").on(table.session_id), index("routine_status_idx").on(table.status)],
)
