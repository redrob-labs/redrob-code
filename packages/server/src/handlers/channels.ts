import { ConflictError, DeskNotFoundError, ServiceUnavailableError } from "@redrob-code/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import * as Channels from "../channels"

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const noDesk = () =>
  new ServiceUnavailableError({ message: "the desk runs only in the registered daemon (redrob service start)", service: "desk" })

const OFF = { enabled: false, signedIn: false, connected: false, pending: [], devices: [] }

function desk() {
  const controller = Channels.current()?.desk
  return controller ? Effect.succeed(controller) : Effect.fail(noDesk())
}

/** A pending code / device id that matches nothing is 404; anything else is a defect (500). */
function lookup<A>(run: () => Promise<A>) {
  return Effect.tryPromise({ try: run, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      error instanceof Channels.DeskNotFound ? Effect.fail(new DeskNotFoundError({ message: message(error) })) : Effect.die(error),
    ),
  )
}

export const ChannelsHandler = HttpApiBuilder.group(Api, "server.channels", (handlers) =>
  handlers
    .handle(
      "channels.status",
      Effect.fn(function* () {
        const controller = Channels.current()
        if (!controller) return { channels: [] }
        const channels = yield* Effect.promise(async () => controller.status())
        return { channels }
      }),
    )
    .handle(
      "channels.reload",
      Effect.fn(function* () {
        const controller = Channels.current()
        if (!controller) return { running: [] }
        const running = yield* Effect.promise(() => controller.reload())
        return { running }
      }),
    )
    .handle(
      "desk.status",
      Effect.fn(function* () {
        const controller = Channels.current()?.desk
        if (!controller) return OFF
        return yield* Effect.promise(() => controller.status())
      }),
    )
    .handle(
      "desk.enable",
      Effect.fn(function* (ctx) {
        const controller = yield* desk()
        return yield* Effect.promise(() => controller.enable(ctx.payload.enabled))
      }),
    )
    .handle(
      "desk.login",
      Effect.fn(function* () {
        const controller = yield* desk()
        return yield* Effect.tryPromise({ try: () => controller.login(), catch: (error) => error }).pipe(
          Effect.catch((error) =>
            error instanceof Channels.DeskConflict
              ? Effect.fail(new ConflictError({ message: message(error), resource: "desk" }))
              : Effect.die(error),
          ),
        )
      }),
    )
    .handle(
      "desk.logout",
      Effect.fn(function* () {
        const controller = yield* desk()
        return yield* Effect.promise(() => controller.logout())
      }),
    )
    .handle(
      "desk.approve",
      Effect.fn(function* (ctx) {
        const controller = yield* desk()
        return yield* lookup(() => controller.approve(ctx.params.code))
      }),
    )
    .handle(
      "desk.deny",
      Effect.fn(function* (ctx) {
        const controller = yield* desk()
        return yield* lookup(() => controller.deny(ctx.params.code))
      }),
    )
    .handle(
      "desk.revoke",
      Effect.fn(function* (ctx) {
        const controller = yield* desk()
        return yield* lookup(() => controller.revoke(ctx.params.id))
      }),
    )
    .handle(
      "desk.machine.get",
      Effect.fn(function* () {
        const controller = yield* desk()
        const read = controller.machine
        if (!read) return yield* Effect.fail(noDesk())
        return yield* Effect.promise(() => read.call(controller))
      }),
    )
    .handle(
      "desk.machine.update",
      Effect.fn(function* (ctx) {
        const controller = yield* desk()
        const update = controller.updateMachine
        if (!update) return yield* Effect.fail(noDesk())
        return yield* Effect.promise(() => update.call(controller, ctx.payload))
      }),
    ),
)
