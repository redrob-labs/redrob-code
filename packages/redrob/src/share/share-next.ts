import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { httpClient } from "@redrob-code/core/effect/app-node-platform"
import { serviceUse } from "@redrob-code/core/effect/service-use"
import { Effect, Exit, Layer, Schema, Scope, Context } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import type { SessionV1 } from "@redrob-code/core/v1/session"
import { Database } from "@redrob-code/core/database/database"
import { eq } from "drizzle-orm"
import { Config } from "@/config/config"
import { SessionShareTable } from "@redrob-code/core/share/sql"
import { ProviderV2 } from "@redrob-code/core/provider"
import { EventV2 } from "@redrob-code/core/event"
import { Flag } from "@redrob-code/core/flag/flag"

/*
  Sharing goes to Redrob Chat, not to opencode's share service.

  A share is an immutable snapshot (`POST /share` on the Redrob Chat API, kind "transcript", source "code"):
  the transcript is sent once, when the user shares, and nothing is streamed afterwards. Unshare is
  `DELETE /share/:id`. The caller is identified by the same Redrob Console API key the `redrob` provider
  spends, sent as a bearer token; there is no second account and no share secret.
*/

const disabled = process.env["REDROB_DISABLE_SHARE"] === "true" || process.env["REDROB_DISABLE_SHARE"] === "1"

/** Production Redrob Chat API. Overridden by `chat.url` in config, then by `REDROB_CHAT_API_URL`. */
export const DEFAULT_CHAT_API_URL = "https://chat-prod.redrob.ai"

export type Api = {
  create: string
  remove: (shareID: string) => string
  data: (shareID: string) => string
}

export type Req = {
  headers: Record<string, string>
  api: Api
  baseUrl: string
}

const CreatedSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
})

/** `secret` is kept for the stored row's shape; Redrob Chat shares carry none, so it is always "". */
export type Share = { id: string; url: string; secret: string }

export type ArtifactInput = {
  title: string
  format: "markdown" | "html" | "code" | "json"
  language?: string
  body: string
}

type State = {
  scope: Scope.Closeable
  shared: Map<SessionID, Share | null>
}

export interface Interface {
  readonly init: () => Effect.Effect<void, unknown>
  readonly url: () => Effect.Effect<string, unknown>
  readonly request: () => Effect.Effect<Req, unknown>
  readonly create: (sessionID: SessionID) => Effect.Effect<Share, unknown>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, unknown>
  /** Share one file or snippet as a standalone artifact. Not tied to a session, so nothing is persisted. */
  readonly artifact: (input: ArtifactInput) => Effect.Effect<{ id: string; url: string }, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@redrob/ShareNext") {}

export const use = serviceUse(Service)

const chatApi: Api = {
  create: "/share",
  remove: (shareID) => `/share/${encodeURIComponent(shareID)}`,
  data: (shareID) => `/share/${encodeURIComponent(shareID)}`,
}

/** Contract limit on the server side; trimming here would silently drop history, so the oldest go first. */
const MAX_MESSAGES = 500

/*
  One line per tool call: the tool name and its title (for file tools that is the path). Inputs and
  outputs are left out on purpose, so a share never carries file contents the conversation did not show.
*/
function toolLine(part: SessionV1.ToolPart) {
  const state = part.state
  const title = state.status === "completed" ? state.title : ""
  const suffix = state.status === "error" ? " (failed)" : ""
  return `> **${part.tool}**${title ? ` ${title}` : ""}${suffix}`
}

function transcript(messages: SessionV1.WithParts[]) {
  const out: Array<{ role: "user" | "assistant"; content: string }> = []
  for (const msg of messages) {
    const lines: string[] = []
    for (const part of msg.parts) {
      if (part.type === "text") {
        if (part.ignored || part.synthetic || !part.text.trim()) continue
        lines.push(part.text)
        continue
      }
      if (part.type === "tool") {
        lines.push(toolLine(part))
        continue
      }
      if (part.type === "file") {
        lines.push(`> attached ${part.filename ?? part.mime}`)
        continue
      }
    }
    const content = lines.join("\n\n").trim()
    if (!content) continue
    out.push({ role: msg.info.role, content })
  }
  return out.slice(-MAX_MESSAGES)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const cfg = yield* Config.Service
    const { db } = yield* Database.Service
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(http)
    const provider = yield* Provider.Service
    const session = yield* Session.Service

    const state: InstanceState.InstanceState<State> = yield* InstanceState.make<State>(
      Effect.fn("ShareNext.state")(function* (_ctx) {
        const cache: State = { scope: yield* Scope.make(), shared: new Map() }

        yield* Effect.addFinalizer(() =>
          Scope.close(cache.scope, Exit.void).pipe(Effect.andThen(Effect.sync(() => cache.shared.clear()))),
        )

        if (disabled) return cache

        const watch = <D extends EventV2.Definition>(
          def: D,
          fn: (data: EventV2.Data<D>) => Effect.Effect<void, unknown>,
        ) =>
          events.listen((event) => {
            if (event.type !== def.type || event.location?.directory !== _ctx.directory) return Effect.void
            return fn(event.data as EventV2.Data<D>).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("share subscriber failed", { type: def.type, cause: cause }),
              ),
            )
          })

        // A deleted session takes its share link down with it.
        yield* watch(Session.Event.Deleted, (data) => remove(data.sessionID))

        return cache
      }),
    )

    /** The Console key the `redrob` provider resolved (env, auth store, config, or launcher). */
    const consoleKey = Effect.fn("ShareNext.consoleKey")(function* () {
      const providers = yield* provider.list()
      const info = providers[ProviderV2.ID.redrob]
      const key = info?.key ?? (info?.options?.["apiKey"] as string | undefined)
      if (!key || key === "public") return undefined
      return key
    })

    const request = Effect.fn("ShareNext.request")(function* () {
      const conf = yield* cfg.get()
      const baseUrl = (Flag.REDROB_CHAT_API_URL ?? conf.chat?.url ?? DEFAULT_CHAT_API_URL).replace(/\/+$/, "")
      const headers: Record<string, string> = {}
      const key = yield* consoleKey()
      if (key) headers.authorization = `Bearer ${key}`
      return { headers, api: chatApi, baseUrl } satisfies Req
    })

    const authorized = Effect.fn("ShareNext.authorized")(function* () {
      const req = yield* request()
      if (!req.headers.authorization) {
        return yield* Effect.fail(
          new Error("Sharing needs a Redrob Console key. Connect with `redrob providers login` first."),
        )
      }
      return req
    })

    const get = Effect.fnUntraced(function* (sessionID: SessionID) {
      const row = yield* db
        .select()
        .from(SessionShareTable)
        .where(eq(SessionShareTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return { id: row.id, secret: row.secret, url: row.url } satisfies Share
    })

    const getCached = Effect.fnUntraced(function* (sessionID: SessionID) {
      const s = yield* InstanceState.get(state)
      if (s.shared.has(sessionID)) {
        const cached = s.shared.get(sessionID)
        return cached === null ? undefined : cached
      }

      const share = yield* get(sessionID)
      s.shared.set(sessionID, share ?? null)
      return share
    })

    const post = Effect.fn("ShareNext.post")(function* (body: Record<string, unknown>) {
      const req = yield* authorized()
      return yield* HttpClientRequest.post(`${req.baseUrl}${req.api.create}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson(body),
        Effect.flatMap((r) => httpOk.execute(r)),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(CreatedSchema)),
      )
    })

    const init = Effect.fn("ShareNext.init")(function* () {
      if (disabled) return
      yield* InstanceState.get(state)
    })

    const url = Effect.fn("ShareNext.url")(function* () {
      return (yield* request()).baseUrl
    })

    const create = Effect.fn("ShareNext.create")(function* (sessionID: SessionID) {
      if (disabled) return { id: "", url: "", secret: "" }
      yield* Effect.logInfo("creating share", { sessionID: sessionID })
      const info = yield* session.get(sessionID)
      const messages = yield* session.messages({ sessionID })
      const created = yield* post({
        kind: "transcript",
        source: "code",
        title: (info.title || "Redrob Code session").slice(0, 200),
        visibility: "unlisted",
        messages: transcript(messages),
      })
      const result: Share = { id: created.id, url: created.url, secret: "" }
      yield* db
        .insert(SessionShareTable)
        .values({ session_id: sessionID, id: result.id, secret: result.secret, url: result.url })
        .onConflictDoUpdate({
          target: SessionShareTable.session_id,
          set: { id: result.id, secret: result.secret, url: result.url },
        })
        .run()
        .pipe(Effect.orDie)
      const s = yield* InstanceState.get(state)
      s.shared.set(sessionID, result)
      return result
    })

    const remove = Effect.fn("ShareNext.remove")(function* (sessionID: SessionID) {
      if (disabled) return
      yield* Effect.logInfo("removing share", { sessionID: sessionID })
      const s = yield* InstanceState.get(state)
      const share = yield* getCached(sessionID)
      if (!share) {
        s.shared.delete(sessionID)
        return
      }

      const req = yield* authorized()
      const res = yield* HttpClientRequest.delete(`${req.baseUrl}${req.api.remove(share.id)}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        Effect.flatMap((r) => http.execute(r)),
      )
      // 404: the link is already gone on the server, which is the state unshare asks for.
      if (res.status >= 400 && res.status !== 404) {
        return yield* Effect.fail(new Error(`Redrob Chat refused to remove the share (${res.status})`))
      }

      yield* db.delete(SessionShareTable).where(eq(SessionShareTable.session_id, sessionID)).run().pipe(Effect.orDie)
      s.shared.delete(sessionID)
    })

    const artifact = Effect.fn("ShareNext.artifact")(function* (input: ArtifactInput) {
      if (disabled) return yield* Effect.fail(new Error("Sharing is disabled (REDROB_DISABLE_SHARE)"))
      const conf = yield* cfg.get()
      if (conf.share === "disabled") return yield* Effect.fail(new Error("Sharing is disabled in configuration"))
      return yield* post({
        kind: "artifact",
        source: "code",
        title: input.title.slice(0, 200),
        visibility: "unlisted",
        artifact: {
          format: input.format,
          ...(input.language ? { language: input.language } : {}),
          body: input.body,
        },
      })
    })

    return Service.of({ init, url, request, create, remove, artifact })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: () => [EventV2Bridge.node, Config.node, Database.node, httpClient, Provider.node, Session.node],
})

export * as ShareNext from "./share-next"
