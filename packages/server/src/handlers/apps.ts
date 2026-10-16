import { AppNotFoundError, InvalidRequestError } from "@redrob-code/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import * as Apps from "../apps"

export const AppsHandler = HttpApiBuilder.group(Api, "server.apps", (handlers) =>
  handlers
    .handle(
      "apps.list",
      Effect.fn(function* () {
        Apps.sweep()
        return { apps: Apps.list(), ttlMs: Apps.TTL_MS }
      }),
    )
    .handle(
      "apps.register",
      Effect.fn(function* (ctx) {
        const { name, mcp_url, pid, version, tools } = ctx.payload
        if (!Apps.normalizeName(name)) {
          return yield* new InvalidRequestError({ message: "name must not be empty", field: "name" })
        }
        if (!Apps.isLoopback(mcp_url)) {
          return yield* new InvalidRequestError({
            message: "mcp_url must be an http(s) URL on 127.0.0.1, localhost or [::1]",
            kind: "not_loopback",
            field: "mcp_url",
          })
        }
        if (!Number.isInteger(pid) || pid <= 0) {
          return yield* new InvalidRequestError({ message: "pid must be a positive integer", field: "pid" })
        }
        const app = Apps.register({
          name,
          mcpUrl: mcp_url,
          pid,
          ...(version !== undefined ? { version } : {}),
          ...(tools !== undefined ? { tools } : {}),
        })
        return { id: app.id, ttlMs: Apps.TTL_MS }
      }),
    )
    .handle(
      "apps.heartbeat",
      Effect.fn(function* (ctx) {
        const app = Apps.heartbeat(ctx.params.appID)
        if (!app) {
          return yield* new AppNotFoundError({
            appID: ctx.params.appID,
            message: "This registration expired or was never made; register again",
          })
        }
        return app
      }),
    )
    .handle(
      "apps.unregister",
      Effect.fn(function* (ctx) {
        Apps.unregister(ctx.params.appID)
        return HttpApiSchema.NoContent.make()
      }),
    ),
)
