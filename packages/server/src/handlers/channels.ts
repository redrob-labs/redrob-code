import { InvalidRequestError } from "@redrob-code/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import * as Channels from "../channels"

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const notRunning = () =>
  new InvalidRequestError({ message: "the desk relay is not running (redrob mobile login)", kind: "not_running" })

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
        const desk = Channels.current()?.desk?.()
        if (!desk) return { running: false, connected: false, pending: [], phones: [] }
        const status = yield* Effect.promise(() => desk.status())
        return { running: true, ...status }
      }),
    )
    .handle(
      "desk.reply",
      Effect.fn(function* (ctx) {
        const desk = Channels.current()?.desk?.()
        if (!desk) return yield* notRunning()
        const { code, decision } = ctx.payload
        return yield* Effect.tryPromise({
          try: () => desk.reply(code, decision),
          catch: (error) => new InvalidRequestError({ message: message(error), field: "code" }),
        })
      }),
    )
    .handle(
      "desk.revoke",
      Effect.fn(function* (ctx) {
        const desk = Channels.current()?.desk?.()
        if (!desk) return yield* notRunning()
        const { id } = ctx.payload
        return yield* Effect.tryPromise({
          try: () => desk.revoke(id),
          catch: (error) => new InvalidRequestError({ message: message(error), field: "id" }),
        })
      }),
    ),
)
