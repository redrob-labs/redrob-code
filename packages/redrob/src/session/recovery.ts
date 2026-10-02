import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { SessionV1 } from "@redrob-code/core/v1/session"
import { Database } from "@redrob-code/core/database/database"
import { MessageTable, PartTable } from "@redrob-code/core/session/sql"
import { InstanceState } from "@/effect/instance-state"
import { and, eq, isNull, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Session } from "./session"
import { MessageID, PartID, SessionID } from "./schema"

/**
 * W-1: work is owned by the engine, not by the client connection that started it.
 *
 * A run already outlives its HTTP request — `Runner.ensureRunning` forks into the instance scope
 * and the request fiber only awaits a Deferred — and `finalizeInterruptedAssistant` in
 * `session/prompt.ts` closes an assistant message out when that run is interrupted in-process.
 *
 * Neither of those helps when the ENGINE PROCESS stops: no finalizer runs. The durable projection
 * is then left mid-turn — an assistant message with no `time.completed`, and the tool call it was
 * executing still `pending` or `running`. A reconnecting client reads that as "still working" and
 * waits forever on a run that no fiber owns.
 *
 * This module closes those out exactly once, when the instance for a directory is first used
 * again. A tool call interrupted this way becomes a terminal `error` that SAYS it may have been
 * half-applied, rather than a `running` state that claims it is still being applied.
 */

/** The error text written onto a tool call the engine was executing when it stopped. */
export const TOOL_INTERRUPTED =
  "The engine stopped while this tool call was running, so its result was never recorded. Any change it had already made to the filesystem or to an external system is still in place. Re-read what it touched before relying on it."

/** The error text written onto an assistant message the engine was generating when it stopped. */
export const MESSAGE_INTERRUPTED = "The engine stopped while this message was being generated."

export interface Candidate {
  readonly message: SessionV1.Info
  readonly parts: readonly SessionV1.Part[]
}

export interface Reconciled {
  /** Present when the message itself changed. */
  readonly message?: SessionV1.Info
  /** Only the parts that changed. */
  readonly parts: readonly SessionV1.Part[]
}

const isNonTerminal = (state: SessionV1.ToolState): state is SessionV1.ToolStatePending | SessionV1.ToolStateRunning =>
  state.status === "pending" || state.status === "running"

/**
 * PURE. Closes one interrupted assistant turn out, given the turn as it was left on disk.
 *
 * Returns only what changed, so a caller can write nothing when there is nothing to write. An
 * already-terminal turn (a completed message) is never rewritten, which is what makes running this
 * at every instance start idempotent.
 */
export const reconcile = (input: { readonly candidate: Candidate; readonly now: number }): Reconciled => {
  const { message } = input.candidate
  if (message.role !== "assistant") return { parts: [] }
  if (message.time.completed !== undefined) return { parts: [] }

  const parts: SessionV1.Part[] = []
  for (const part of input.candidate.parts) {
    if (part.type !== "tool") continue
    if (!isNonTerminal(part.state)) continue
    const start = part.state.status === "running" ? part.state.time.start : message.time.created
    parts.push({
      ...part,
      state: {
        status: "error",
        input: part.state.input,
        error: TOOL_INTERRUPTED,
        metadata: part.state.status === "running" ? part.state.metadata : undefined,
        time: { start, end: Math.max(start, input.now) },
      },
    })
  }

  const next: SessionV1.Info = {
    ...message,
    error: message.error ?? { name: "MessageAbortedError", data: { message: MESSAGE_INTERRUPTED } },
    time: { ...message.time, completed: input.now },
  }
  return { message: next, parts }
}

export interface Interface {
  /** Closes out every turn this directory was left mid-way through. Idempotent. */
  readonly run: Effect.Effect<{ readonly messages: number; readonly toolCalls: number }>
}

export class Service extends Context.Service<Service, Interface>()("@redrob/SessionRecovery") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessions = yield* Session.Service

    const sweep = Effect.fn("SessionRecovery.sweep")(function* () {
      const directory = yield* InstanceState.directory
      // Assistant messages with no completion stamp. `data` is the encoded V1 Info, so the
      // completion stamp is a JSON path rather than a column.
      const rows = yield* db
        .select({ id: MessageTable.id, session_id: MessageTable.session_id, data: MessageTable.data })
        .from(MessageTable)
        .where(
          and(
            sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
            isNull(sql`json_extract(${MessageTable.data}, '$.time.completed')`),
          ),
        )
        .all()
        .pipe(Effect.orDie)

      let messages = 0
      let toolCalls = 0
      for (const row of rows) {
        const session = yield* sessions.get(SessionID.make(row.session_id)).pipe(Effect.option)
        if (session._tag === "None") continue
        if (session.value.directory !== directory) continue

        const message = {
          ...row.data,
          id: MessageID.make(row.id),
          sessionID: SessionID.make(row.session_id),
        } as SessionV1.Info

        const partRows = yield* db
          .select()
          .from(PartTable)
          .where(eq(PartTable.message_id, MessageID.make(row.id)))
          .orderBy(PartTable.id)
          .all()
          .pipe(Effect.orDie)

        const parts = partRows.map(
          (part) =>
            ({
              ...part.data,
              id: PartID.make(part.id),
              sessionID: SessionID.make(part.session_id),
              messageID: MessageID.make(part.message_id),
            }) as SessionV1.Part,
        )

        const result = reconcile({ candidate: { message, parts }, now: Date.now() })
        for (const part of result.parts) {
          yield* sessions.updatePart(part)
          toolCalls += 1
        }
        if (result.message) {
          yield* sessions.updateMessage(result.message)
          messages += 1
        }
      }

      if (messages > 0 || toolCalls > 0) {
        yield* Effect.logInfo("recovered interrupted session work", { directory, messages, toolCalls })
      }
      return { messages, toolCalls }
    })

    // One sweep per directory per process: the InstanceState cache keeps the Effect's result.
    const state = yield* InstanceState.make(() => sweep())

    return Service.of({ run: InstanceState.get(state) })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: () => [Database.node, Session.node] })

export * as SessionRecovery from "./recovery"
