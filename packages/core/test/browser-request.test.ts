import { describe, expect } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { AppNodeBuilder } from "@redrob-code/core/effect/app-node-builder"
import { EventV2 } from "@redrob-code/core/event"
import { BrowserRequestV1 } from "@redrob-code/core/browser-request"
import { SessionV2 } from "@redrob-code/core/session"
import { testEffect } from "./lib/effect"

const browser = AppNodeBuilder.build(LayerNode.group([EventV2.node, BrowserRequestV1.node]))
const it = testEffect(browser)

const sessionID = SessionV2.ID.make("ses_browser_test")
const command: BrowserRequestV1.Command = { action: "page.text" }

/** Forks an ask and returns once its `asked` event has been observed on the stream. */
const waitForAsk = Effect.fn("BrowserRequestV1Test.waitForAsk")(function* (
  service: BrowserRequestV1.Interface,
  input: BrowserRequestV1.AskInput,
) {
  const events = yield* EventV2.Service
  const asked = yield* Deferred.make<BrowserRequestV1.Request>()
  const unsubscribe = yield* events.listen((event) =>
    event.type === BrowserRequestV1.Event.Asked.type
      ? Deferred.succeed(asked, event.data as BrowserRequestV1.Request).pipe(Effect.asVoid)
      : Effect.void,
  )
  yield* Effect.addFinalizer(() => unsubscribe)
  const fiber = yield* service.ask(input).pipe(Effect.forkScoped)
  return { fiber, request: yield* Deferred.await(asked) }
})

describe("BrowserRequestV1", () => {
  it.effect("publishes the action on the event stream and settles on a reply", () =>
    Effect.gen(function* () {
      const service = yield* BrowserRequestV1.Service
      const events = yield* EventV2.Service
      const published: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type.startsWith("browser.request.")) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const { fiber, request } = yield* waitForAsk(service, { sessionID, command })

      expect(request.id).toMatch(/^brq_/)
      // The command travels whole: a client that only got the action name could not act.
      expect(request.command).toEqual(command)
      expect(yield* service.list()).toEqual([request])

      yield* service.reply({ requestID: request.id, value: { type: "string", value: "page body" } })

      expect(yield* Fiber.join(fiber)).toEqual({ type: "string", value: "page body" })
      expect(yield* service.list()).toEqual([])
      expect(published.map((event) => event.type)).toEqual([
        BrowserRequestV1.Event.Asked.type,
        BrowserRequestV1.Event.Answered.type,
      ])
    }),
  )

  it.effect("a refusal fails the ask with the client's own reason", () =>
    Effect.gen(function* () {
      const service = yield* BrowserRequestV1.Service
      const { fiber, request } = yield* waitForAsk(service, {
        sessionID,
        command: { action: "page.click", selector: "#buy" },
      })

      yield* service.refuse({ requestID: request.id, reason: "that tab is not shared with the agent" })

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect(error).toBeInstanceOf(BrowserRequestV1.RefusedError)
      expect((error as BrowserRequestV1.RefusedError).message).toBe(
        "the browser refused page.click: that tab is not shared with the agent",
      )
      // Settled either way: a refused request must not keep occupying the pending map.
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("settling an unknown id is refused rather than ignored", () =>
    Effect.gen(function* () {
      const service = yield* BrowserRequestV1.Service
      const unknown = BrowserRequestV1.ID.make("brq_unknown")

      const replied = yield* service
        .reply({ requestID: unknown, value: { type: "void" } })
        .pipe(Effect.exit)
      const refused = yield* service.refuse({ requestID: unknown, reason: "whatever" }).pipe(Effect.exit)

      expect(Exit.isFailure(replied)).toBe(true)
      expect(Exit.isFailure(refused)).toBe(true)
    }),
  )

  /**
   * The deadline is the reason this service can be used by a skill at all.
   *
   * Nothing tells the engine whether a client is subscribed — the event stream has no
   * subscriber count — so "no browser attached" is indistinguishable from "the browser is
   * slow". Waiting forever would hang the session of anyone who calls `page.text()` with no
   * browser running, which is the single outcome that is certainly wrong.
   *
   * Driven by the TestClock, so this asserts the real `DEADLINE` constant without the suite
   * paying twenty seconds of wall clock for it.
   */
  it.effect("an unanswered request fails on the deadline, naming the action", () =>
    Effect.gen(function* () {
      const service = yield* BrowserRequestV1.Service
      const fiber = yield* service.ask({ sessionID, command }).pipe(Effect.forkScoped)

      yield* TestClock.adjust(Duration.sum(BrowserRequestV1.DEADLINE, Duration.seconds(1)))

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect(error).toBeInstanceOf(BrowserRequestV1.UnansweredError)
      expect((error as BrowserRequestV1.UnansweredError).action).toBe("page.text")
      expect((error as BrowserRequestV1.UnansweredError).message).toContain("no browser client answered page.text")
      // And it is no longer pending: a request nobody answered must not leak.
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("a request answered before the deadline does NOT fail", () =>
    Effect.gen(function* () {
      // The other half of the deadline test. A timeout that fires regardless would pass the
      // test above and break every real call.
      const service = yield* BrowserRequestV1.Service
      const { fiber, request } = yield* waitForAsk(service, { sessionID, command })

      yield* service.reply({ requestID: request.id, value: { type: "void" } })
      yield* TestClock.adjust(Duration.sum(BrowserRequestV1.DEADLINE, Duration.seconds(1)))

      expect(yield* Fiber.join(fiber)).toEqual({ type: "void" })
    }),
  )
})
