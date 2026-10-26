export * as SessionRunnerModel from "./model"

import { makeLocationNode } from "../../effect/app-node"
import { LLMError, type Model } from "@redrob-code/llm"
import * as AnthropicMessages from "@redrob-code/llm/protocols/anthropic-messages"
import * as OpenAICompatibleChat from "@redrob-code/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@redrob-code/llm/protocols/openai-responses"
import { Auth, type AnyRoute, type TransportDef } from "@redrob-code/llm/route"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { produce } from "immer"
import { Catalog } from "../../catalog"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import {
  consoleCharLimit,
  describeConsoleSwitch,
  parseConsoleCharLimit,
  rememberConsoleCharLimit,
  routeConsoleBody,
  type ConsoleRouteBudget,
} from "../../plugin/provider/redrob-body-budget"
import { ProviderV2 } from "../../provider"
import { SessionSchema } from "../schema"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
  },
) {
  override get message() {
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}

export class VariantUnavailableError extends Schema.TaggedErrorClass<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    variant: ModelV2.VariantID,
  },
) {
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`
  }
}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    api: Schema.String,
  },
) {
  override get message() {
    return `Unsupported API for ${this.providerID}/${this.modelID}: ${this.api}`
  }
}

export type Error =
  | ModelNotSelectedError
  | ModelUnavailableError
  | VariantUnavailableError
  | UnsupportedApiError
  | Integration.AuthorizationError

export interface Interface {
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<Model, Error>
}

export class Service extends Context.Service<Service, Interface>()("@redrob/v2/SessionRunnerModel") {}

/** Test or embedding seam for supplying a model resolver directly. */
export const layerWith = (resolve: Interface["resolve"]) => Layer.succeed(Service, Service.of({ resolve }))

const apiKey = (model: ModelV2.Info, credential?: Credential.Value) => {
  if (credential?.type === "key") return Auth.value(credential.key)
  if (credential?.type === "oauth") return Auth.value(credential.access)
  const value = model.request.body.apiKey ?? model.api.settings?.apiKey
  if (typeof value === "string") return Auth.value(value)
}

const withDefaults = (model: ModelV2.Info, route: AnyRoute) => {
  const body = model.request.body
  const httpBody = Object.hasOwn(body, "apiKey")
    ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "apiKey"))
    : body
  return route.with({
    provider: model.providerID,
    endpoint: model.api.url === undefined ? undefined : { baseURL: model.api.url },
    headers: model.request.headers,
    http: { body: httpBody },
    limits: { context: model.limit.context, output: model.limit.output },
  })
}

const withVariant = (
  model: ModelV2.Info,
  variantID: ModelV2.VariantID | undefined,
): Effect.Effect<ModelV2.Info, VariantUnavailableError> => {
  const id = variantID === "default" || variantID === undefined ? model.request.variant : variantID
  const variant = model.variants.find((item) => item.id === id)
  if (!variant && variantID !== undefined && variantID !== "default")
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: variantID,
      }),
    )
  return Effect.succeed(
    variant
      ? produce(model, (draft) => {
          Object.assign(draft.request.headers, variant.headers)
          Object.assign(draft.request.body, variant.body)
        })
      : model,
  )
}

/** The console's "longer than this model accepts (N characters ...)" limit, from a failed request. */
const consoleLengthLimit = (error: unknown) => {
  if (!(error instanceof LLMError) || error.reason._tag !== "InvalidRequest") return undefined
  const status = error.reason.http?.response?.status
  if (status !== undefined && status !== 400 && status !== 413) return undefined
  return parseConsoleCharLimit(error.reason.http?.body ?? error.reason.message)
}

// Console requests are shrunk to the console's byte limit and the model's learned character limit
// before they are sent, and a step whose images the selected model cannot take goes to a vision model
// for that one request (routeConsoleBody). When the console reports the model's character limit, it is
// remembered (not for a router id such as `auto`) and the same request is re-sent once, budgeted to it,
// before the error reaches the runner (which then compacts; the compaction request goes through here
// too).
const withConsoleBodyBudget = <Body, Prepared extends object>(
  transport: TransportDef<Body, Prepared, unknown>,
): TransportDef<Body, Prepared, unknown> => {
  type Input = Parameters<TransportDef<Body, Prepared, unknown>["prepare"]>[0]
  // The unbudgeted input each prepared request came from, the model id it was sent to, and the
  // character limit it was already budgeted to, for the one re-send.
  const inputs = new WeakMap<Prepared, { input: Input; model: string | undefined; chars: number | undefined }>()
  const modelOf = (body: unknown) =>
    body !== null && typeof body === "object" && "model" in body && typeof body.model === "string"
      ? body.model
      : undefined
  const prepare = (input: Input, limit?: ConsoleRouteBudget) =>
    Effect.gen(function* () {
      const route = routeConsoleBody(input.body, limit)
      if (route.switched) yield* Effect.logInfo(describeConsoleSwitch(route.switched))
      const prepared = yield* transport.prepare({ ...input, body: route.body })
      const model = modelOf(route.body)
      inputs.set(prepared, { input, model, chars: limit?.charsByModel?.[model ?? ""] ?? consoleCharLimit(model) })
      return prepared
    })
  return {
    ...transport,
    prepare: (input) => prepare(input),
    frames: (prepared, request, runtime) => {
      let started = false
      return transport.frames(prepared, request, runtime).pipe(
        Stream.tap(() => Effect.sync(() => void (started = true))),
        Stream.catch((error) => {
          const sent = inputs.get(prepared)
          const limit = started || sent === undefined ? undefined : consoleLengthLimit(error)
          const model = sent?.model
          if (sent === undefined || limit === undefined || model === undefined) return Stream.fail(error)
          // Already budgeted to this limit: re-sending would send the same body.
          if (sent.chars === limit) return Stream.fail(error)
          const remembered = rememberConsoleCharLimit(model, limit)
          return Stream.unwrap(
            prepare(sent.input, remembered ? undefined : { charsByModel: { [model]: limit } }).pipe(
              Effect.map((next) => transport.frames(next, request, runtime)),
            ),
          )
        }),
      )
    },
  }
}

const apiName = (model: ModelV2.Info) =>
  model.api.type === "aisdk" ? `${model.api.type}:${model.api.package}` : model.api.type

export const fromCatalogModel = (
  model: ModelV2.Info,
  credential?: Credential.Value,
): Effect.Effect<Model, UnsupportedApiError> => {
  const resolved =
    credential?.type !== "key" || credential.metadata === undefined
      ? model
      : produce(model, (draft) => {
          Object.assign(draft.request.body, credential.metadata)
        })
  const key = apiKey(resolved, credential)
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai") {
    return Effect.succeed(
      withDefaults(resolved, OpenAIResponses.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/anthropic") {
    return Effect.succeed(
      withDefaults(resolved, AnthropicMessages.route)
        .with({ auth: key === undefined ? Auth.none : Auth.header("x-api-key", key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai-compatible" && resolved.api.url) {
    // The console (Vercel) rejects bodies over 2 MB, so its requests, compaction included, are
    // shrunk to CONSOLE_MAX_BODY_BYTES before encoding. See ../../plugin/provider/redrob-body-budget.ts.
    const route =
      resolved.providerID === ProviderV2.ID.redrob
        ? OpenAICompatibleChat.route.with({ transport: withConsoleBodyBudget(OpenAICompatibleChat.route.transport) })
        : OpenAICompatibleChat.route
    return Effect.succeed(
      withDefaults(resolved, route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  return Effect.fail(
    new UnsupportedApiError({
      providerID: resolved.providerID,
      modelID: resolved.id,
      api: apiName(resolved),
    }),
  )
}

export const resolve = (session: SessionSchema.Info, model: ModelV2.Info, credential?: Credential.Value) =>
  withVariant(model, session.model?.variant).pipe(Effect.flatMap((model) => fromCatalogModel(model, credential)))

export const supported = (model: ModelV2.Info) =>
  model.api.type === "aisdk" &&
  (model.api.package === "@ai-sdk/openai" ||
    model.api.package === "@ai-sdk/anthropic" ||
    (model.api.package === "@ai-sdk/openai-compatible" && model.api.url !== undefined))

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
        // Location plugins populate and filter the catalog asynchronously during layer startup.
        const defaultModel = session.model ? undefined : yield* catalog.model.default()
        const selected = session.model
          ? (yield* catalog.model.available()).find(
              (model) => model.providerID === session.model?.providerID && model.id === session.model.id,
            )
          : defaultModel && supported(defaultModel)
            ? defaultModel
            : (yield* catalog.model.available()).find(supported)
        if (!selected && session.model)
          return yield* new ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })
        const provider = yield* catalog.provider.get(selected.providerID)
        const connection = yield* integrations.connection.active(
          provider?.integrationID ?? Integration.ID.make(selected.providerID),
        )
        return yield* resolve(
          session,
          selected,
          connection ? yield* integrations.connection.resolve(connection) : undefined,
        )
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer: locationLayer, deps: () => [Catalog.node, Integration.node] })
