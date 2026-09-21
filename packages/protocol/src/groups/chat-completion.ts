/**
 * `POST /v1/chat/completions` — the OpenAI-compatible inference route.
 *
 * This is the one surface every Redrob product is meant to reach the engine
 * through: it carries the engine's own Console credential, so a product never
 * holds a key of its own, and it resolves the same provider registry the agent
 * does, so a locally-served model is reachable through the same call.
 *
 * It is NOT the agent. A chat completion is stateless and a session is not, so
 * this route makes one model call and returns; mapping it onto the session API
 * is what produced the broken half-implementations this replaces (see
 * docs/LOCAL-ENGINE-API.md).
 *
 * WHO EXECUTES TOOLS IS DECIDED BY THE REQUEST, and that is the whole contract:
 *
 *   - `tools` present -> the CALLER owns them. Nothing is executed here; the
 *     turn ends with `finish_reason: "tool_calls"` and the caller sends the
 *     results back as `role: "tool"` messages. Standard OpenAI semantics.
 *   - `tools` absent -> a plain completion.
 *
 * Hosts whose tools mutate something they hold — an open document, a live
 * browser tab — cannot hand execution to the engine, so caller ownership is a
 * requirement for them rather than a preference.
 *
 * The path is versioned, not the engine: fields may be ADDED here, but removing
 * one or changing its meaning requires /v2. Products negotiate with
 * /api/capabilities instead of pinning an engine version.
 */
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

/** OpenAI puts the function under a `function` key and tags the wrapper. */
const FunctionTool = Schema.Struct({
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    description: Schema.optional(Schema.String),
    /** Raw JSON Schema, passed to the provider untouched. */
    parameters: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
})

const ToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    /** A JSON *string*, which is what OpenAI clients parse. */
    arguments: Schema.String,
  }),
})

/**
 * Message content is a string in the common case and a part array when a client
 * sends images. `Schema.Unknown` for the array case keeps this route from
 * becoming a second, divergent definition of multimodal content — the parts are
 * handed to the provider layer, which owns that shape.
 */
const MessageContent = Schema.Union([
  Schema.String,
  Schema.Null,
  Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
])

const Message = Schema.Struct({
  role: Schema.Literals(["system", "developer", "user", "assistant", "tool"]),
  content: Schema.optional(MessageContent),
  /** Present on an assistant message that is replaying a previous tool turn. */
  tool_calls: Schema.optional(Schema.Array(ToolCall)),
  /** Required on a `tool` message: which call this is the result of. */
  tool_call_id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
})

const ToolChoice = Schema.Union([
  Schema.Literals(["auto", "none", "required"]),
  Schema.Struct({
    type: Schema.Literal("function"),
    function: Schema.Struct({ name: Schema.String }),
  }),
])

export const ChatCompletionRequest = Schema.Struct({
  /** `redrob/auto` routes through the Console; a local provider id stays local. */
  model: Schema.String,
  messages: Schema.Array(Message),
  tools: Schema.optional(Schema.Array(FunctionTool)),
  tool_choice: Schema.optional(ToolChoice),
  /** Default false. True returns text/event-stream. */
  stream: Schema.optional(Schema.Boolean),
  max_tokens: Schema.optional(Schema.Int),
  /** OpenAI's newer name for the same cap; `max_tokens` wins if both appear. */
  max_completion_tokens: Schema.optional(Schema.Int),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  stop: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  seed: Schema.optional(Schema.Int),
  frequency_penalty: Schema.optional(Schema.Number),
  presence_penalty: Schema.optional(Schema.Number),
  /** Passed through where the provider accepts it. */
  reasoning_effort: Schema.optional(Schema.String),
  /** Accepted and ignored: a caller may send it, and refusing would be rude. */
  user: Schema.optional(Schema.String),
}).annotate({ identifier: "ChatCompletionRequest" })
export type ChatCompletionRequest = typeof ChatCompletionRequest.Type

const Usage = Schema.Struct({
  prompt_tokens: Schema.Int,
  completion_tokens: Schema.Int,
  total_tokens: Schema.Int,
})

const Choice = Schema.Struct({
  index: Schema.Int,
  message: Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.NullOr(Schema.String),
    tool_calls: Schema.optional(Schema.Array(ToolCall)),
    /** Present when the model emitted reasoning; not an OpenAI field. */
    reasoning_content: Schema.optional(Schema.String),
  }),
  finish_reason: Schema.NullOr(Schema.String),
})

export const ChatCompletionResponse = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("chat.completion"),
  created: Schema.Int,
  model: Schema.String,
  choices: Schema.Array(Choice),
  usage: Schema.optional(Usage),
}).annotate({ identifier: "ChatCompletionResponse" })
export type ChatCompletionResponse = typeof ChatCompletionResponse.Type

/**
 * The OpenAI error envelope, so a client's existing error handling works
 * unchanged.
 *
 * `code` is the part clients must branch on. `engine_not_authenticated` means
 * the ENGINE has no Console credential, and it is the only condition under which
 * a client should offer a sign-in action — the message text is localized
 * downstream and is not a contract. Branching on text instead is how a network
 * timeout reached a user as "please log in".
 *
 * One class per status, because the status is what a client's transport sees
 * first and collapsing them would report a rejected key as a bad request. The
 * body shape is identical across all of them.
 */
const errorFields = {
  error: Schema.Struct({
    message: Schema.String,
    type: Schema.String,
    code: Schema.NullOr(Schema.String),
    param: Schema.optional(Schema.NullOr(Schema.String)),
  }),
}

export class ChatBadRequestError extends Schema.ErrorClass<ChatBadRequestError>("ChatBadRequestError")(
  errorFields,
  { httpApiStatus: 400 },
) {}

/** Rejected or absent credentials. Carries code `engine_not_authenticated`. */
export class ChatUnauthorizedError extends Schema.ErrorClass<ChatUnauthorizedError>("ChatUnauthorizedError")(
  errorFields,
  { httpApiStatus: 401 },
) {}

export class ChatRateLimitError extends Schema.ErrorClass<ChatRateLimitError>("ChatRateLimitError")(
  errorFields,
  { httpApiStatus: 429 },
) {}

/** Upstream failed, or no route could be resolved for the requested model. */
export class ChatUpstreamError extends Schema.ErrorClass<ChatUpstreamError>("ChatUpstreamError")(
  errorFields,
  { httpApiStatus: 502 },
) {}

export const ChatCompletionGroup = HttpApiGroup.make("server.chat")
  .add(
    HttpApiEndpoint.post("chat.completions", "/v1/chat/completions", {
      payload: ChatCompletionRequest,
      success: ChatCompletionResponse,
      error: [ChatBadRequestError, ChatUnauthorizedError, ChatRateLimitError, ChatUpstreamError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v1.chat.completions",
        summary: "Create a chat completion",
        description:
          "OpenAI-compatible inference against the engine's own credential and provider registry. " +
          "Declaring `tools` makes the caller responsible for executing them: the turn ends with " +
          "finish_reason tool_calls and the results come back as role:tool messages. " +
          "`stream: true` returns text/event-stream instead of this JSON body.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "chat completions",
      description: "OpenAI-compatible inference route. The shared engine surface for Redrob products.",
    }),
  )
