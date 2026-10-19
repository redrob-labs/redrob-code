/**
 * `POST /v1/chat/completions` — see docs/LOCAL-ENGINE-API.md and
 * protocol/groups/chat-completion.ts for the contract.
 *
 * This handler deliberately does NOT touch Session, Agent or the tool runtime.
 * It resolves a provider the way the agent does, makes one model call, and
 * translates. Everything stateful belongs to the session API.
 *
 * `handleRaw` rather than `handle`, because the reply is JSON or
 * text/event-stream depending on `stream`, and only the raw form can return an
 * HttpServerResponse of its own choosing.
 */
import { Catalog } from "@redrob-code/core/catalog"
import { Integration } from "@redrob-code/core/integration"
import { ModelV2 } from "@redrob-code/core/model"
import { ProviderV2 } from "@redrob-code/core/provider"
import { Mask } from "@redrob-code/core/privacy/mask"
import { Privacy } from "@redrob-code/core/privacy/service"
import { SkillV2 } from "@redrob-code/core/skill"
import { SkillArming } from "@redrob-code/core/skill/arming"
import { fromCatalogModel } from "@redrob-code/core/session/runner/model"
import { LLM, LLMError, LLMResponse, Message } from "@redrob-code/llm"
import type { LLMEvent, LLMRequest } from "@redrob-code/llm"
import type { Credential } from "@redrob-code/schema/credential"
import { ChatCompletionRequest } from "@redrob-code/protocol/groups/chat-completion"
import { Effect, Option, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"
import {
  ConversionError,
  toFinishReason,
  toGeneration,
  toLLMMessages,
  toLLMTools,
  toWireToolCalls,
} from "./chat-completion-wire"

/** OpenAI ids are `chatcmpl-<opaque>`; clients log and correlate on them. */
function completionID(): string {
  return `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`
}

function seconds(): number {
  return Math.floor(Date.now() / 1000)
}

interface WireError {
  readonly status: 400 | 401 | 429 | 502
  readonly message: string
  readonly type: string
  readonly code: string | null
}

/**
 * Maps an engine failure onto the OpenAI error envelope.
 *
 * `engine_not_authenticated` is the load-bearing value: it is the only code a
 * client may turn into a sign-in prompt, and it covers both a missing credential
 * and one the provider rejected — from the caller's side those are the same
 * problem, and neither is fixed by retrying.
 *
 * Note what is NOT mapped to auth. The executor classifies a content-policy body
 * BEFORE it looks at the status, so an upstream 401 whose body mentions safety
 * arrives as ContentPolicy. That ordering is upstream's and this reads whatever
 * it produced rather than second-guessing it — reclassifying here would report a
 * policy refusal as a login problem.
 */
function toWireError(error: unknown): WireError {
  if (error instanceof ConversionError) {
    return { status: 400, message: error.message, type: "invalid_request_error", code: null }
  }
  if (error instanceof LLMError) {
    const reason = error.reason
    switch (reason._tag) {
      case "Authentication":
        return {
          status: 401,
          message: reason.message,
          type: "authentication_error",
          code: "engine_not_authenticated",
        }
      case "InvalidRequest":
        return { status: 400, message: reason.message, type: "invalid_request_error", code: null }
      case "RateLimit":
        return { status: 429, message: reason.message, type: "rate_limit_error", code: "rate_limit_exceeded" }
      case "QuotaExceeded":
        return { status: 429, message: reason.message, type: "insufficient_quota", code: "insufficient_quota" }
      case "ContentPolicy":
        return { status: 400, message: reason.message, type: "invalid_request_error", code: "content_policy_violation" }
      default:
        return { status: 502, message: reason.message, type: "api_error", code: null }
    }
  }
  // A body that does not decode against ChatCompletionRequest is the CALLER's
  // error, so it must not fall through to the 502 catch-all below.
  // `schemaBodyJson` fails with `HttpServerError | Schema.SchemaError`, and both
  // mean the request never reached a provider — reporting them as `api_error` told
  // a caller the upstream had failed when in fact their own payload was malformed,
  // which sends them debugging the wrong system.
  if (isRequestDecodeError(error)) {
    return {
      status: 400,
      message: error instanceof Error ? error.message : String(error),
      type: "invalid_request_error",
      code: null,
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 502, message, type: "api_error", code: null }
}

/**
 * Whether this failure happened while reading the request, before any provider was
 * involved.
 *
 * Matched structurally rather than with `instanceof`: `Schema.SchemaError` and the
 * HTTP request errors are separate hierarchies, and an `instanceof` chain over both
 * silently stops matching when either is re-exported through a different module
 * instance. The `_tag` values are part of those errors' public shape.
 */
function isRequestDecodeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const tag = (error as { _tag?: unknown })._tag
  return tag === "SchemaError" || tag === "RequestError" || tag === "HttpServerError"
}

function errorResponse(error: unknown): Effect.Effect<HttpServerResponse.HttpServerResponse> {
  const wire = toWireError(error)
  return HttpServerResponse.json(
    { error: { message: wire.message, type: wire.type, code: wire.code, param: null } },
    { status: wire.status },
  ).pipe(Effect.orDie)
}

/**
 * Resolves the requested model the way the agent does: catalog entry plus the
 * active integration credential. `redrob/auto` is the Console route; any other
 * `provider/model` string resolves against the same registry, which is how a
 * locally served model becomes reachable without a second code path.
 *
 * A caller-supplied base URL is deliberately NOT accepted. The config layer only
 * admits a new openai-compatible provider at a local address (isLocalEndpoint);
 * honouring an arbitrary URL here would bypass that check and forward the
 * engine's own credential to whatever host the caller named.
 */
const resolveModel = Effect.fn("chat.resolveModel")(function* (model: string) {
  const [providerPart, ...rest] = model.split("/")
  const providerID = ProviderV2.ID.make(rest.length > 0 ? providerPart! : "redrob")
  const modelID = ModelV2.ID.make(rest.length > 0 ? rest.join("/") : model)

  const catalog = yield* Catalog.Service
  const info = yield* catalog.model.get(providerID, modelID)
  if (info === undefined) {
    return yield* Effect.fail(new ConversionError(`model ${model} is not available on this engine`, "model"))
  }

  const integrations = yield* Integration.Service
  let credential: Credential.Value | undefined
  // `active` has no error channel; only `resolve` can fail, and a failure there
  // means "no usable credential", which the provider layer reports better than a
  // 500 from here would.
  const connection = yield* integrations.connection.active(Integration.ID.make(providerID))
  if (connection !== undefined) {
    credential = yield* integrations.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
  }
  return yield* fromCatalogModel(info, credential)
})

/**
 * Caller labels forwarded to the provider, so the Console can group AI work by app and session
 * exactly as it does for the agent runner. A shared daemon serves several apps at once, so these
 * cannot come from the engine's own environment: each request names its app and session. They are
 * labels and nothing else -- an absent header sends nothing.
 */
export const APP_HEADER = "x-redrob-app"
export const SESSION_HEADER = "x-redrob-session"

export function callerLabels(headers: Record<string, string>): Record<string, string> {
  const app = headers[APP_HEADER]?.trim()
  const session = headers[SESSION_HEADER]?.trim()
  return {
    ...(app ? { [APP_HEADER]: app } : {}),
    ...(session ? { "X-Session-Id": session, "x-session-affinity": session } : {}),
  }
}

/**
 * Skill arming on this route.
 *
 * The route stays sessionless, but a skill that declares `keywords:` or `urls:` arms here
 * exactly as it does in a session: the last user message is matched against the keywords,
 * and `redrob_context.page_url` (the tab the browser's task is on) against the URL globs.
 * Armed bodies go in as ONE extra system message, placed after the caller's own system
 * messages so the caller's instructions still come first.
 *
 * Read through `serviceOption`: a host that serves this route without the skill service
 * gets today's behaviour instead of a missing-service failure, and any failure while
 * listing skills costs the arming, never the completion.
 */
const attribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

function lastUserText(payload: ChatCompletionRequest): string {
  for (let index = payload.messages.length - 1; index >= 0; index -= 1) {
    const message = payload.messages[index]!
    if (message.role !== "user") continue
    const content = message.content
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .map((part) => (part["type"] === "text" && typeof part["text"] === "string" ? (part["text"] as string) : ""))
        .join("\n")
    }
    return ""
  }
  return ""
}

export const withArmedSkills = Effect.fn("chat.armedSkills")(function* (
  payload: ChatCompletionRequest,
  messages: ReadonlyArray<Message>,
) {
  const service = yield* Effect.serviceOption(SkillV2.Service)
  if (Option.isNone(service)) return messages
  const skills = yield* service.value.list().pipe(Effect.catchCause(() => Effect.succeed([] as SkillV2.Info[])))
  const pageUrl = payload.redrob_context?.page_url?.trim() || undefined
  const armed = SkillArming.arm({ skills, prompt: lastUserText(payload), url: pageUrl })
  if (armed.length === 0) return messages

  const byName = new Map(skills.map((skill) => [skill.name, skill] as const))
  const sections: string[] = []
  for (const entry of armed) {
    const info = byName.get(entry.name)
    if (info === undefined || info.content.trim().length === 0) continue
    const why = [...entry.keywords.map((k) => `keyword ${k}`), ...entry.urls.map((u) => `url ${u}`)].join(", ")
    sections.push(`  <skill name="${attribute(entry.name)}" armed-by="${attribute(why)}">`, info.content, "  </skill>")
  }
  if (sections.length === 0) return messages

  const title = payload.redrob_context?.page_title?.trim()
  const text = [
    "<armed_skills>",
    "These skills armed themselves on this request: their own keywords matched what the user typed,",
    "or their URL globs matched the page the task is on" +
      (pageUrl ? ` (${title ? `${attribute(title)} - ` : ""}${attribute(pageUrl)}).` : "."),
    "Follow them when they apply; they are already loaded.",
    ...sections,
    "</armed_skills>",
  ].join("\n")

  const insertAt = messages.findIndex((message) => message.role !== "system")
  const at = insertAt === -1 ? messages.length : insertAt
  return [...messages.slice(0, at), Message.system(text), ...messages.slice(at)]
})

const buildRequest = Effect.fn("chat.buildRequest")(function* (
  payload: ChatCompletionRequest,
  labels: Record<string, string> = {},
) {
  const model = yield* resolveModel(payload.model)
  const messages = yield* withArmedSkills(payload, toLLMMessages(payload))
  const tools = toLLMTools(payload)
  const generation = toGeneration(payload)
  return LLM.request({
    model,
    ...(Object.keys(labels).length > 0 ? { http: { headers: labels } } : {}),
    messages,
    // Absent tools is what selects engine-owned behaviour; an empty array would
    // tell the provider "you may call nothing", which is a different thing.
    ...(tools ? { tools: tools.definitions, ...(tools.choice ? { toolChoice: tools.choice } : {}) } : {}),
    ...(generation ? { generation } : {}),
  })
})

/**
 * PII masking on this route, with the same switch and the same masker as the agent runner
 * (session/runner/llm.ts). A caller sends its whole history with real values each time, so one
 * vault per request is enough: placeholders only have to agree within a request, and the answer
 * is put back before it leaves. The model tier asks the configured LOCAL model for names,
 * organisations and places exactly as the runner does.
 */
export const maskedRequest = Effect.fn("chat.mask")(function* (unmasked: LLMRequest) {
  const privacy = yield* (yield* Privacy.Service).get()
  if (privacy.mode === "off") return { request: unmasked, unmask: undefined }
  const vault = new Mask.Vault()
  if (privacy.mode === "model" && privacy.model) {
    const text = Mask.readableTexts(unmasked).join("\n")
    const local = yield* resolveModel(privacy.model).pipe(Effect.option)
    if (text.length > 0 && Option.isSome(local)) {
      const answer = yield* LLM.generate(
        LLM.request({
          model: local.value,
          messages: [Message.user(Mask.ENTITY_PROMPT + text)],
          tools: [],
          generation: { maxTokens: 512 },
        }),
      ).pipe(Effect.option)
      if (Option.isSome(answer)) for (const entity of Mask.parseEntities(answer.value.text)) vault.add(entity)
    }
  }
  return { request: Mask.maskRequest(vault, unmasked), unmask: Mask.unmaskEvents(vault) }
})

/** The provider stream, with real values put back when masking is on. */
export function maskedStream(request: LLMRequest, unmask: ReturnType<typeof Mask.unmaskEvents> | undefined) {
  const events = LLM.stream(request)
  return unmask ? events.pipe(Stream.flatMap((event) => Stream.fromIterable(unmask(event)))) : events
}

/** `LLM.generate`, over the unmasked stream: the response is assembled from what the caller may read. */
export const maskedGenerate = Effect.fn("chat.generate")(function* (
  request: LLMRequest,
  unmask: ReturnType<typeof Mask.unmaskEvents> | undefined,
) {
  if (!unmask) return yield* LLM.generate(request)
  const state = yield* maskedStream(request, unmask).pipe(Stream.runFold(LLMResponse.empty, LLMResponse.reduce))
  const response = LLMResponse.complete(state)
  if (response) return response
  return yield* Effect.fail(new ConversionError("Provider stream ended without a terminal finish event", "model"))
})

function toJsonBody(id: string, model: string, response: LLMResponse): unknown {
  const toolCalls = toWireToolCalls(
    response.toolCalls.map((call) => ({ id: call.id, name: call.name, input: call.input })),
  )
  const usage = response.usage
  return {
    id,
    object: "chat.completion",
    created: seconds(),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: response.text.length > 0 ? response.text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toFinishReason(response.finishReason),
      },
    ],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.inputTokens ?? 0,
            completion_tokens: usage.outputTokens ?? 0,
            total_tokens: usage.totalTokens ?? 0,
          },
        }
      : {}),
  }
}

/** One SSE frame carrying an OpenAI chunk. */
function chunkFrame(id: string, model: string, delta: unknown, finishReason: string | null): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: seconds(),
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    }),
  }
}

function doneFrame(): Sse.Event {
  return { _tag: "Event", event: "message", id: undefined, data: "[DONE]" }
}

/**
 * Translates the engine's event stream into OpenAI chunks.
 *
 * Two things here are not obvious. Tool-call fragments are emitted from the
 * COMPLETED `tool-call` event rather than from `tool-input-delta`, because the
 * engine parses arguments and the wire wants a JSON string — re-emitting
 * fragments would mean re-serializing a half-parsed value. And `provider-error`
 * arrives as a stream ELEMENT, not a failure, so it is matched explicitly: left
 * unhandled, an upstream 500 would end the stream with a clean `[DONE]` and the
 * caller would read a truncated answer as a complete one.
 */
function toChunks(id: string, model: string, events: Stream.Stream<LLMEvent, LLMError>) {
  return events.pipe(
    Stream.flatMap((event: LLMEvent) => Stream.fromIterable(eventFrames(id, model, event))),
    Stream.concat(Stream.make(doneFrame())),
  )
}

function eventFrames(id: string, model: string, event: LLMEvent): ReadonlyArray<Sse.Event> {
  switch (event.type) {
    case "text-delta":
      return [chunkFrame(id, model, { content: event.text }, null)]
    case "reasoning-delta":
      return [chunkFrame(id, model, { reasoning_content: event.text }, null)]
    case "tool-call": {
      const [call] = toWireToolCalls([{ id: event.id, name: event.name, input: event.input }])
      return [chunkFrame(id, model, { tool_calls: [{ index: 0, ...call }] }, null)]
    }
    case "finish":
      return [chunkFrame(id, model, {}, toFinishReason(event.reason))]
    case "provider-error":
      // Surfaced as data, not as a stream failure: headers are already sent, so
      // this is the only way the caller learns the turn broke.
      return [
        {
          _tag: "Event" as const,
          event: "message",
          id: undefined,
          data: JSON.stringify({
            error: { message: event.message, type: "api_error", code: null, param: null },
          }),
        },
      ]
    default:
      return []
  }
}

export const ChatCompletionHandler = HttpApiBuilder.group(Api, "server.chat", (handlers) =>
  Effect.gen(function* () {
    return handlers.handleRaw("chat.completions", () =>
      Effect.gen(function* () {
        // handleRaw does not decode the payload — that is the cost of being able
        // to answer with either JSON or an event stream. The declared schema is
        // still the contract, so it is applied here rather than trusting the body.
        const payload = yield* HttpServerRequest.schemaBodyJson(ChatCompletionRequest)
        const incoming = yield* HttpServerRequest.HttpServerRequest
        const id = completionID()
        const { request, unmask } = yield* maskedRequest(yield* buildRequest(payload, callerLabels(incoming.headers)))

        if (payload.stream !== true) {
          const response = yield* maskedGenerate(request, unmask)
          return yield* HttpServerResponse.json(toJsonBody(id, payload.model, response)).pipe(Effect.orDie)
        }

        // Streaming: the error envelope can only be sent before the first byte,
        // so a failure after headers travels as an SSE error frame (see
        // eventFrames) rather than as a status code.
        const frames = toChunks(id, payload.model, maskedStream(request, unmask)).pipe(
          Stream.pipeThroughChannel(Sse.encode()),
          Stream.encodeText,
        )
        return HttpServerResponse.stream(frames, {
          contentType: "text/event-stream",
          headers: {
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "X-Content-Type-Options": "nosniff",
          },
        })
      }).pipe(Effect.catch((error) => errorResponse(error))),
    )
  }),
)
