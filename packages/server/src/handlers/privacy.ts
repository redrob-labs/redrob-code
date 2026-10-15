import { Privacy } from "@redrob-code/core/privacy/service"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const PrivacyHandler = HttpApiBuilder.group(Api, "server.privacy", (handlers) =>
  handlers
    .handle(
      "privacy.get",
      Effect.fn(function* () {
        return yield* (yield* Privacy.Service).get()
      }),
    )
    .handle(
      "privacy.set",
      Effect.fn(function* (ctx) {
        return yield* (yield* Privacy.Service).set(ctx.payload).pipe(Effect.orDie)
      }),
    ),
)
