import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import * as Channels from "../channels"

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
    ),
)
