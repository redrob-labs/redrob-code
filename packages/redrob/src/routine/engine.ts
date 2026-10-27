import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import type { SessionID } from "@/session/schema"
import { Cause, Context, Cron, Duration, Effect, FiberMap, Layer, Option, Schedule, Stream } from "effect"
import { Routine } from "./store"
import { RoutineMarker } from "./marker"
import { RoutineWatch } from "./watch"

/**
 * Runs routines. One engine per server process; it holds a fiber per routine it owns.
 *
 * A routine is run only by the process that holds its lease (see `Routine.claim`). Three loops keep
 * that true without anyone coordinating:
 *
 *  - on `routine.updated`, a routine this process created or resumed is armed, and one that left
 *    `running` is disarmed;
 *  - a heartbeat renews every lease this process holds, and disarms a routine whose lease it lost,
 *    which is also how a stop made in another process reaches this one;
 *  - a sweep arms running routines no live process holds, which is how a restart re-arms them.
 *
 * Every wake sends ONE ordinary prompt to the routine's session, so it costs what typing the same
 * thing would cost and shows in the transcript as exactly that.
 */

export interface Interface {
  /** Arms every running routine no live process holds. Also runs on a timer. */
  readonly sweep: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@redrob/RoutineEngine") {}

const RENEW_EVERY = Duration.millis(Routine.LEASE_MS / 3)
const SWEEP_EVERY = Duration.millis(Routine.LEASE_MS)

/** A status in which the session is mid-turn, so a wake must wait for it. */
const isBusy = (status: SessionStatus.Info) => status.type === "busy" || status.type === "retry"

/** Milliseconds until a schedule next fires. */
export function nextDelay(trigger: Extract<Routine.Trigger, { type: "schedule" }>, now = Date.now()): number {
  if (trigger.every !== undefined) return trigger.every * 1000
  const cron = Cron.parseUnsafe(trigger.cron ?? "", trigger.timezone)
  return Math.max(0, Cron.next(cron, new Date(now)).getTime() - now)
}

const replyText = (parts: readonly { type: string; text?: string; synthetic?: boolean }[]) =>
  parts
    .filter((part) => part.type === "text" && part.synthetic !== true && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* Routine.Service
    const instances = yield* InstanceStore.Service
    const prompt = yield* SessionPrompt.Service
    const status = yield* SessionStatus.Service
    const events = yield* EventV2Bridge.Service
    const fibers = yield* FiberMap.make<Routine.ID>()

    /** Resolves once the session is between turns. A user's turn in flight is waited out, never interrupted. */
    const waitIdle = Effect.fn("RoutineEngine.waitIdle")(function* (sessionID: SessionID) {
      while (isBusy(yield* status.get(sessionID))) {
        // The timeout covers the gap between reading the status and subscribing.
        yield* events.subscribe(SessionStatus.Event.Status).pipe(
          Stream.filter((event) => event.data.sessionID === sessionID && !isBusy(event.data.status)),
          Stream.take(1),
          Stream.runDrain,
          Effect.timeoutOption("30 seconds"),
        )
      }
    })

    /**
     * Waits for this routine's trigger to fire. Returns what woke it, or undefined when there is
     * nothing left to wait for (the routine was finished while waiting).
     */
    const waitForWake = Effect.fn("RoutineEngine.waitForWake")(function* (routine: Routine.Runnable) {
      const trigger = routine.info.trigger
      if (trigger.type === "after_turn") return { wake: { type: "after_turn" } as const, finished: false }
      if (trigger.type === "schedule") {
        yield* Effect.sleep(Duration.millis(nextDelay(trigger)))
        return { wake: { type: "schedule" } as const, finished: false }
      }

      const interval = Duration.seconds(trigger.interval ?? Routine.DEFAULT_WATCH_INTERVAL)
      let before = RoutineWatch.parseFingerprint(routine.fingerprint)
      let first = before === undefined
      while (true) {
        // The first read only records where the subject stands; it is not a change.
        if (!first) yield* Effect.sleep(interval)
        const read = yield* RoutineWatch.readPullRequest(trigger.url, routine.directory).pipe(Effect.option)
        if (Option.isNone(read)) {
          yield* Effect.logWarning("routine watch read failed", { id: routine.info.id, url: trigger.url })
          first = false
          continue
        }
        const after = read.value
        const fingerprint = RoutineWatch.fingerprint(after)
        if (first) {
          first = false
          before = after
          yield* store.record(routine.info.id, { fingerprint })
          if (RoutineWatch.isFinished(after)) {
            yield* store.record(routine.info.id, {
              status: "done",
              reason: `The pull request is already ${after.state}.`,
            })
            return undefined
          }
          continue
        }
        if (before && fingerprint === RoutineWatch.fingerprint(before)) continue
        const change = RoutineWatch.describeChange(before, after)
        before = after
        yield* store.record(routine.info.id, { fingerprint })
        return { wake: { type: "watch", change } as const, finished: RoutineWatch.isFinished(after) }
      }
    })

    /** One routine's life in this process. Ends when the routine leaves `running`. */
    const run = Effect.fn("RoutineEngine.run")(function* (id: Routine.ID) {
      while (true) {
        const current = yield* store.runnable(id)
        if (!current || current.info.status !== "running") return

        const woke = yield* waitForWake(current)
        if (!woke) return

        yield* waitIdle(current.info.sessionID)

        // Re-read: it may have been paused, stopped or deleted while this fiber waited.
        const routine = yield* store.runnable(id)
        if (!routine || routine.info.status !== "running") return

        const cycle = routine.info.cycles + 1
        const text = RoutineMarker.cyclePrompt({
          goal: routine.info.goal,
          ledger: routine.ledger,
          cycle,
          maxCycles: routine.info.maxCycles,
          wake: woke.wake,
        })

        const reply = yield* prompt
          .prompt({ sessionID: routine.info.sessionID, parts: [{ type: "text", text }] })
          .pipe(Effect.result)

        if (reply._tag === "Failure") {
          // A failed send ends the routine rather than retrying blind into a session it cannot see.
          yield* store
            .record(id, {
              status: "stopped",
              cycles: cycle,
              reason: `The prompt could not be sent: ${String(reply.failure)}`,
            })
            .pipe(Effect.uninterruptible)
          return
        }

        const info = reply.success.info
        if (info.role === "assistant" && info.error) {
          // Whatever failed will keep failing; re-prompting turns one visible error into a stream of them.
          const message = "message" in info.error.data ? String(info.error.data.message) : info.error.name
          yield* store
            .record(id, { status: "stopped", cycles: cycle, reason: `The turn failed: ${message}` })
            .pipe(Effect.uninterruptible)
          return
        }

        const verdict = RoutineMarker.judge({
          reply: replyText(reply.success.parts),
          ledger: routine.ledger,
          cycles: cycle,
          maxCycles: routine.info.maxCycles,
          trigger: routine.info.trigger.type,
        })

        const patch: Routine.Patch =
          verdict.type === "done"
            ? { status: "done", reason: "The goal is met." }
            : verdict.type === "blocked"
              ? { status: "blocked", reason: "The agent needs a person to continue." }
              : verdict.type === "stalled"
                ? { status: "blocked", reason: `The same next step came up three times in a row: ${verdict.step}` }
                : verdict.type === "exhausted"
                  ? { status: "stopped", reason: `Reached the limit of ${routine.info.maxCycles} cycles.` }
                  : woke.finished
                    ? { status: "done", reason: "The watched pull request is merged or closed." }
                    : {}

        // Written before the next wait, not only at the end: the cycle that crashes is the one worth remembering.
        yield* store.record(id, { ...patch, cycles: cycle, ledger: verdict.ledger }).pipe(Effect.uninterruptible)
        if (patch.status !== undefined) return
      }
    })

    const arm = Effect.fn("RoutineEngine.arm")(function* (routine: Routine.Runnable) {
      if (yield* FiberMap.has(fibers, routine.info.id)) return
      if (!(yield* store.claim(routine.info.id))) return
      const id = routine.info.id
      yield* FiberMap.run(
        fibers,
        id,
        instances.provide({ directory: routine.directory }, run(id)).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : store
                  .record(id, {
                    status: "stopped",
                    reason: `The routine engine failed: ${Cause.pretty(cause).split("\n")[0]}`,
                  })
                  .pipe(Effect.asVoid),
          ),
          Effect.ensuring(store.release(id)),
        ),
        { onlyIfMissing: true },
      )
    })

    const sweep: Interface["sweep"] = Effect.fn("RoutineEngine.sweep")(function* () {
      for (const routine of yield* store.orphans()) {
        if (routine.info.trigger.type === "after_turn") {
          // An autopilot whose process died is not restarted on its own: whoever was watching it is
          // gone too, and a loop that resumes unseen spends turns nobody asked for. It waits to be resumed.
          if (yield* store.claim(routine.info.id)) {
            yield* store.record(routine.info.id, {
              status: "paused",
              reason: "The engine restarted while this autopilot was running. Resume it to continue.",
            })
          }
          continue
        }
        yield* arm(routine)
      }
    })

    const renew = Effect.fn("RoutineEngine.renew")(function* () {
      for (const [id] of Array.from(fibers)) {
        if (!(yield* store.claim(id))) yield* FiberMap.remove(fibers, id)
      }
    })

    yield* events.subscribe(Routine.Event.Updated).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const info = event.data.info
          if (info.status !== "running") return yield* FiberMap.remove(fibers, info.id)
          const routine = yield* store.runnable(info.id)
          if (routine && routine.info.status === "running") yield* arm(routine)
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("routine event handling failed", { cause }))),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* renew().pipe(
      Effect.catchCause((cause) => Effect.logWarning("routine lease renewal failed", { cause })),
      Effect.repeat(Schedule.spaced(RENEW_EVERY)),
      Effect.forkScoped,
    )

    yield* sweep().pipe(
      Effect.catchCause((cause) => Effect.logWarning("routine sweep failed", { cause })),
      Effect.repeat(Schedule.spaced(SWEEP_EVERY)),
      Effect.forkScoped,
    )

    return Service.of({ sweep })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: () => [Routine.node, InstanceStore.node, SessionPrompt.node, SessionStatus.node, EventV2Bridge.node],
})

export * as RoutineEngine from "./engine"
