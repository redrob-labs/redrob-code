import { test, type TestOptions } from "bun:test"
import { ConfigV1 } from "@redrob-code/core/v1/config/config"
import { Cause, Duration, Effect, Exit, Layer } from "effect"
import * as Scope from "effect/Scope"
import * as TestClock from "effect/testing/TestClock"
import * as TestConsole from "effect/testing/TestConsole"
import { memoMap } from "@redrob-code/core/effect/memo-map"
import type { Config } from "@/config/config"
import { TestInstance, withTmpdirInstance } from "../fixture/fixture"
import { InstanceStore } from "@/project/instance-store"

type Body<A, E, R> = Effect.Effect<A, E, R> | (() => Effect.Effect<A, E, R>)
type InstanceOptions<E, R> = {
  git?: boolean
  config?: Partial<ConfigV1.Info> | (() => Partial<ConfigV1.Info>)
  init?: (directory: string) => Effect.Effect<void, E, R>
}

function isInstanceOptions<E, R>(
  options: InstanceOptions<E, R> | number | TestOptions | undefined,
): options is InstanceOptions<E, R> {
  return !!options && typeof options === "object" && ("git" in options || "config" in options || "init" in options)
}

function instanceArgs<E, R>(
  options?: InstanceOptions<E, R> | number | TestOptions,
  testOptions?: number | TestOptions,
): { instanceOptions: InstanceOptions<E, R> | undefined; testOptions: number | TestOptions | undefined } {
  if (typeof options === "number") return { instanceOptions: undefined, testOptions: options }
  if (isInstanceOptions(options)) return { instanceOptions: options, testOptions }
  return { instanceOptions: undefined, testOptions: options }
}

const body = <A, E, R>(value: Body<A, E, R>) => Effect.suspend(() => (typeof value === "function" ? value() : value))

type Runner = <A, E, R, E2>(value: Body<A, E, R | Scope.Scope>, layer: Layer.Layer<R, E2>) => Promise<A>

const isolatedRun: Runner = (value, layer) =>
  Effect.gen(function* () {
    const exit = yield* body(value).pipe(Effect.scoped, Effect.provide(layer), Effect.exit)
    if (Exit.isFailure(exit)) {
      for (const err of Cause.prettyErrors(exit.cause)) {
        yield* Effect.logError(err)
      }
    }
    return yield* exit
  }).pipe(Effect.runPromise)

// Builds the test layer through the shared process-wide memoMap so cached
// services (Bus, Session, …) match Server.Default's instances. Use for tests
// that publish to an in-process HTTP server and need pub/sub identity with
// the server's handlers.
const sharedRun: Runner = (value, layer) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const ctx = yield* Layer.buildWithMemoMap(layer, memoMap, scope)
    const exit = yield* body(value).pipe(Effect.scoped, Effect.provide(ctx), Effect.exit)
    yield* Scope.close(scope, Exit.void)
    if (Exit.isFailure(exit)) {
      for (const err of Cause.prettyErrors(exit.cause)) {
        yield* Effect.logError(err)
      }
    }
    return yield* exit
  }).pipe(Effect.runPromise)

const make = <R, E>(testLayer: Layer.Layer<R, E>, liveLayer: Layer.Layer<R, E>, run: Runner = isolatedRun) => {
  const effect = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test(name, () => run(value, testLayer), opts)

  effect.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.only(name, () => run(value, testLayer), opts)

  effect.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.skip(name, () => run(value, testLayer), opts)

  const live = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test(name, () => run(value, liveLayer), opts)

  live.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.only(name, () => run(value, liveLayer), opts)

  live.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.skip(name, () => run(value, liveLayer), opts)

  const instance = <A, E2, E3 = never>(
    name: string,
    value: Body<A, E2, R | InstanceStore.Service | TestInstance | Scope.Scope>,
    options?: InstanceOptions<E3, R | Scope.Scope> | number | TestOptions,
    opts?: number | TestOptions,
  ) => {
    const args = instanceArgs(options, opts)
    return test(
      name,
      () => run(body(value).pipe(withTmpdirInstance(args.instanceOptions)), liveLayer),
      args.testOptions,
    )
  }

  instance.only = <A, E2, E3 = never>(
    name: string,
    value: Body<A, E2, R | InstanceStore.Service | TestInstance | Scope.Scope>,
    options?: InstanceOptions<E3, R | Scope.Scope> | number | TestOptions,
    opts?: number | TestOptions,
  ) => {
    const args = instanceArgs(options, opts)
    return test.only(
      name,
      () => run(body(value).pipe(withTmpdirInstance(args.instanceOptions)), liveLayer),
      args.testOptions,
    )
  }

  instance.skip = <A, E2, E3 = never>(
    name: string,
    value: Body<A, E2, R | InstanceStore.Service | TestInstance | Scope.Scope>,
    options?: InstanceOptions<E3, R | Scope.Scope> | number | TestOptions,
    opts?: number | TestOptions,
  ) => {
    const args = instanceArgs(options, opts)
    return test.skip(
      name,
      () => run(body(value).pipe(withTmpdirInstance(args.instanceOptions)), liveLayer),
      args.testOptions,
    )
  }

  return { effect, live, instance }
}

// Test environment with TestClock and TestConsole
const testEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer())

// Live environment - uses real clock, but keeps TestConsole for output capture
const liveEnv = TestConsole.layer

export const it = make<never, never>(testEnv, liveEnv)

export const testEffect = <R, E>(layer: Layer.Layer<R, E>) =>
  make<R, E>(Layer.provideMerge(layer, testEnv), Layer.provideMerge(layer, liveEnv))

// Variant of `testEffect` that builds the test layer through the shared
// process-wide memoMap so services like Bus/Session resolve to the same
// instances Server.Default uses. Use when a test needs pub/sub identity with
// an in-process HTTP server — most tests should stick with `testEffect`.
export const testEffectShared = <R, E>(layer: Layer.Layer<R, E>) =>
  make<R, E>(Layer.provideMerge(layer, testEnv), Layer.provideMerge(layer, liveEnv), sharedRun)

// These two helpers exist to NAME a failure, not to impose a deadline tighter than the
// harness already applies. `bun test --timeout 30000` is the real bound; a helper that gives
// up at 5 seconds is making its own bet about how fast the machine is, and that bet lost —
// `prompt.test.ts` failed in CI at 5114ms against a 5000ms ceiling while passing on an idle
// 16-core host.
//
// Waiting on an event rather than a clock would be better and is not available here. These
// wait on state behind an HTTP API — has this message been promoted, is the search index
// ready — with nothing to subscribe to. Making them event-driven means the server exposing a
// readiness signal per resource: a product change across 26 different waits, not a test one.
//
// So the ceilings are generous instead of tight. That costs nothing when the condition holds,
// because a poll returns the moment it does; it only bounds how long a genuine failure takes
// to report. The message now says how long it actually waited, so the next failure is
// diagnosable rather than merely late.
const describeWait = (message: string, startedAt: number, attempts?: number) => {
  const elapsed = Math.round(Date.now() - startedAt)
  return attempts === undefined
    ? `${message} (waited ${elapsed}ms)`
    : `${message} (waited ${elapsed}ms over ${attempts} attempt(s))`
}

export const awaitWithTimeout = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  message: string,
  duration: Duration.Input = "10 seconds",
) =>
  // `suspend` so the clock starts when the effect RUNS, not when it is described. Reading
  // Date.now() at construction would measure from whenever the test built its pipeline.
  Effect.suspend(() => {
    const startedAt = Date.now()
    return self.pipe(
      Effect.timeoutOrElse({
        duration,
        orElse: () => Effect.fail(new Error(describeWait(message, startedAt))),
      }),
    )
  })

export const pollWithTimeout = <A, E, R>(
  self: Effect.Effect<A | undefined, E, R>,
  message: string,
  duration: Duration.Input = "20 seconds",
) =>
  Effect.suspend(() => {
    const startedAt = Date.now()
    let attempts = 0
    return Effect.gen(function* () {
      // Backs off from 20ms to a 250ms cap. A fixed 20ms interval under a 20-second ceiling
      // is up to a thousand requests aimed at the very thing being waited for, which can slow
      // down what it is waiting for. Starting tight keeps a fast condition fast.
      let interval = 20
      while (true) {
        attempts++
        const result = yield* self
        if (result !== undefined) return result
        yield* Effect.sleep(Duration.millis(interval))
        interval = Math.min(interval * 2, 250)
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration,
        orElse: () => Effect.fail(new Error(describeWait(message, startedAt, attempts))),
      }),
    )
  })
