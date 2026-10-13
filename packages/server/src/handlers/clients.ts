import { ClientNotFoundError } from "@redrob-code/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import * as Clients from "../clients"

/** The daemon's idle policy, set by `redrob serve --register --idle-exit`; absent when it stays up. */
let idleExitAfterMs: number | undefined

export function setIdleExitAfterMs(value: number | undefined): void {
  idleExitAfterMs = value
}

export const ClientsHandler = HttpApiBuilder.group(Api, "server.clients", (handlers) =>
  handlers
    .handle(
      "clients.list",
      Effect.fn(function* () {
        Clients.sweep()
        const idleForMs = Clients.idleFor()
        return {
          clients: Clients.list(),
          ttlMs: Clients.TTL_MS,
          ...(idleForMs === undefined ? {} : { idleForMs }),
          ...(idleExitAfterMs === undefined ? {} : { idleExitAfterMs }),
        }
      }),
    )
    .handle(
      "clients.attach",
      Effect.fn(function* (ctx) {
        return Clients.attach(ctx.payload)
      }),
    )
    .handle(
      "clients.heartbeat",
      Effect.fn(function* (ctx) {
        const client = Clients.heartbeat(ctx.params.clientID)
        if (!client) {
          return yield* new ClientNotFoundError({
            clientID: ctx.params.clientID,
            message: "This attachment expired or was never made; attach again",
          })
        }
        return client
      }),
    )
    .handle(
      "clients.detach",
      Effect.fn(function* (ctx) {
        Clients.detach(ctx.params.clientID)
        return HttpApiSchema.NoContent.make()
      }),
    ),
)
