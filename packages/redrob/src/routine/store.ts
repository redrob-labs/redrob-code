import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { Database } from "@redrob-code/core/database/database"
import { MessageTable, PartTable } from "@redrob-code/core/session/sql"
import { Storage } from "@/storage/storage"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import { and, inArray, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { RoutineProposal } from "./proposal"
import { RoutineSimilarity } from "./similarity"

/**
 * W-5: notice that the user has done substantially the same thing several times, and offer to make
 * it a routine.
 *
 * Only the reading and the remembering live here. The two decisions are in `./similarity` and
 * `./proposal`, both pure, both unit-tested without a session — this service exists so the pure
 * code has real prompts and durable answers to work on.
 *
 * NOT in this item: creating the routine. W-5 is the PROPOSAL; `accept` records that the user said
 * yes and stops the offer coming back. Nothing here schedules anything, because the engine has no
 * routine scheduler to schedule it on — see the pull request body for that gap, stated rather
 * than papered over.
 */

const STATE_KEY = ["routine", "proposal-state"]

/** How far back prompts are read. Anything older is not evidence of a current habit. */
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000

/** Hard cap on prompts read per sweep, so a long-lived project cannot make this unbounded. */
const MAX_PROMPTS = 500

export interface Interface {
  /** Repetitions the user's recent prompts contain, strongest first. Reads only. */
  readonly repetitions: Effect.Effect<readonly RoutineSimilarity.Repetition[]>
  /** The one routine worth proposing now, plus why each other candidate was held back. */
  readonly pending: Effect.Effect<RoutineProposal.Decision>
  /** Records that a proposal was shown. Starts the quiet period. */
  readonly offered: (key: string, occurrences: number) => Effect.Effect<void>
  /** Records the user's answer. An accept is final; a decline backs off and may become final. */
  readonly answer: (key: string, answer: RoutineProposal.Answer) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@redrob/RoutineProposalStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const storage = yield* Storage.Service
    const sessions = yield* Session.Service

    const readState = Effect.fn("RoutineProposal.readState")(function* () {
      return yield* storage
        .read<RoutineProposal.State>(STATE_KEY)
        .pipe(Effect.catch(() => Effect.succeed(RoutineProposal.emptyState)))
    })

    const writeState = (state: RoutineProposal.State) => storage.write(STATE_KEY, state).pipe(Effect.ignore)

    const occurrences = Effect.fn("RoutineProposal.occurrences")(function* () {
      const since = Date.now() - LOOKBACK_MS
      const rows = yield* db
        .select({
          id: MessageTable.id,
          session_id: MessageTable.session_id,
          time_created: MessageTable.time_created,
        })
        .from(MessageTable)
        .where(
          and(
            sql`json_extract(${MessageTable.data}, '$.role') = 'user'`,
            sql`${MessageTable.time_created} >= ${since}`,
          ),
        )
        .orderBy(MessageTable.time_created)
        .limit(MAX_PROMPTS)
        .all()
        .pipe(Effect.orDie)
      if (rows.length === 0) return []

      // A prompt the user typed is the text parts of their message, in order. Synthetic parts
      // (injected reminders, attachment stubs) are not something the user repeated, so a prompt
      // is assembled from the text the user actually wrote.
      const parts = yield* db
        .select({ message_id: PartTable.message_id, id: PartTable.id, data: PartTable.data })
        .from(PartTable)
        .where(
          inArray(
            PartTable.message_id,
            rows.map((row) => row.id),
          ),
        )
        .orderBy(PartTable.message_id, PartTable.id)
        .all()
        .pipe(Effect.orDie)

      const text = new Map<string, string[]>()
      for (const part of parts) {
        const data = part.data as { type?: string; text?: string; synthetic?: boolean }
        if (data.type !== "text" || data.synthetic === true || typeof data.text !== "string") continue
        const bucket = text.get(part.message_id) ?? []
        bucket.push(data.text)
        text.set(part.message_id, bucket)
      }

      const result: RoutineSimilarity.Occurrence[] = []
      const directory = yield* InstanceState.directory
      const known = new Map<string, boolean>()
      for (const row of rows) {
        const prompt = (text.get(row.id) ?? []).join(" ").trim()
        if (prompt.length === 0) continue
        // Sessions outside this instance's directory are another project's habits.
        let inScope = known.get(row.session_id)
        if (inScope === undefined) {
          const session = yield* sessions.get(SessionID.make(row.session_id)).pipe(Effect.option)
          inScope = session._tag === "Some" && session.value.directory === directory
          known.set(row.session_id, inScope)
        }
        if (!inScope) continue
        result.push({ id: row.id, prompt, at: row.time_created })
      }
      return result
    })

    const repetitions = Effect.gen(function* () {
      return RoutineSimilarity.groupRepetitions(yield* occurrences(), { now: Date.now() })
    })

    const pending = Effect.gen(function* () {
      return RoutineProposal.decide({
        repetitions: yield* repetitions,
        state: yield* readState(),
        now: Date.now(),
      })
    })

    return Service.of({
      repetitions,
      pending,
      offered: (key, count) =>
        Effect.gen(function* () {
          const state = yield* readState()
          yield* writeState(RoutineProposal.recordOffer(state, { key, at: Date.now(), occurrences: count }))
        }),
      answer: (key, answer) =>
        Effect.gen(function* () {
          const state = yield* readState()
          yield* writeState(RoutineProposal.recordAnswer(state, { key, answer, at: Date.now() }))
        }),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: () => [Database.node, Storage.node, Session.node],
})

export * as RoutineProposalStore from "./store"
