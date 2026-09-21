/**
 * Translation between the OpenAI chat-completions wire format and this engine's
 * LLM schema. Pure: no Effect, no services, no I/O — so the parts most likely to
 * be wrong are the parts that can be tested directly.
 *
 * Direction matters here. Requests come in from a caller we do not control, so
 * every field is validated or ignored rather than trusted. Responses go out to
 * clients that already exist (redrob-browser builds and parses this format
 * today), so the output shape is fixed by them, not by convenience.
 */
import { Message, ToolCallPart, ToolDefinition, ToolResultPart } from "@redrob-code/llm"
import type { ChatCompletionRequest } from "@redrob-code/protocol/groups/chat-completion"

/** What the caller declared, after validation. */
export interface ToolsIn {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly choice: "auto" | "none" | "required" | { readonly name: string } | undefined
}

export class ConversionError extends Error {
  constructor(
    message: string,
    readonly param: string | undefined,
  ) {
    super(message)
    this.name = "ConversionError"
  }
}

/**
 * OpenAI allows string content or an array of parts. The array form is passed
 * through as text parts only: media parts need a mediaType this route has no
 * validated source for, and silently dropping an image would be worse than
 * saying so.
 */
function contentParts(
  content: ChatCompletionRequest["messages"][number]["content"],
  where: string,
): ReadonlyArray<ReturnType<typeof Message.text>> {
  if (content === undefined || content === null) return []
  if (typeof content === "string") return content.length > 0 ? [Message.text(content)] : []
  const parts: Array<ReturnType<typeof Message.text>> = []
  for (const part of content) {
    const type = part["type"]
    if (type === "text" && typeof part["text"] === "string") {
      parts.push(Message.text(part["text"] as string))
      continue
    }
    throw new ConversionError(
      `${where}: content part of type ${String(type)} is not supported on this route`,
      "messages",
    )
  }
  return parts
}

/**
 * `system` and `developer` both become a system message: OpenAI renamed the role
 * and kept accepting the old one, so a caller may send either.
 *
 * A `tool` message must name the call it answers. Without `tool_call_id` the
 * provider cannot pair it with the assistant turn that asked, and the model sees
 * an orphan result — so this is rejected rather than guessed at.
 */
export function toLLMMessages(request: ChatCompletionRequest): ReadonlyArray<Message> {
  const out: Array<Message> = []
  request.messages.forEach((message, index) => {
    const where = `messages[${index}]`
    switch (message.role) {
      case "system":
      case "developer": {
        const text = typeof message.content === "string" ? message.content : ""
        if (text.length > 0) out.push(Message.system(text))
        return
      }
      case "user": {
        out.push(Message.make({ role: "user", content: [...contentParts(message.content, where)] }))
        return
      }
      case "assistant": {
        // An assistant turn being replayed can carry text, tool calls, or both.
        const parts: Array<ReturnType<typeof Message.text> | ToolCallPart> = [
          ...contentParts(message.content, where),
        ]
        for (const call of message.tool_calls ?? []) {
          parts.push(
            ToolCallPart.make({
              id: call.id,
              name: call.function.name,
              // The wire carries a JSON string; the engine wants the parsed value.
              // A malformed string is the caller's bug and must not be forwarded
              // as a silently empty argument object.
              input: parseArguments(call.function.arguments, `${where}.tool_calls`),
            }),
          )
        }
        if (parts.length > 0) out.push(Message.make({ role: "assistant", content: parts }))
        return
      }
      case "tool": {
        if (message.tool_call_id === undefined || message.tool_call_id.length === 0) {
          throw new ConversionError(`${where}: a tool message requires tool_call_id`, "messages")
        }
        out.push(
          Message.tool(
            ToolResultPart.make({
              id: message.tool_call_id,
              name: message.name ?? "",
              result: typeof message.content === "string" ? message.content : "",
            }),
          ),
        )
        return
      }
    }
  })
  return out
}

function parseArguments(raw: string, where: string): unknown {
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new ConversionError(`${where}: arguments is not valid JSON`, "messages")
  }
}

/**
 * A declared tool with no `parameters` still needs a schema the provider will
 * accept, so it becomes an empty object schema rather than being dropped.
 *
 * `description` is required by ToolDefinition and optional on the wire; an empty
 * string is the honest default — inventing one would put words in the model's
 * prompt that the caller never wrote.
 */
export function toLLMTools(request: ChatCompletionRequest): ToolsIn | undefined {
  if (request.tools === undefined || request.tools.length === 0) return undefined
  const definitions = request.tools.map((tool, index) => {
    if (tool.function.name.length === 0) {
      throw new ConversionError(`tools[${index}]: function.name is required`, "tools")
    }
    return new ToolDefinition({
      name: tool.function.name,
      description: tool.function.description ?? "",
      inputSchema: tool.function.parameters ?? { type: "object", properties: {} },
    })
  })
  return { definitions, choice: toToolChoice(request.tool_choice) }
}

function toToolChoice(choice: ChatCompletionRequest["tool_choice"]): ToolsIn["choice"] {
  if (choice === undefined) return undefined
  if (typeof choice === "string") return choice
  return { name: choice.function.name }
}

/** OpenAI's finish_reason vocabulary. The engine's is close but not identical. */
export function toFinishReason(reason: string | undefined): string | null {
  switch (reason) {
    case "stop":
      return "stop"
    case "length":
      return "length"
    case "tool-calls":
      return "tool_calls"
    case "content-filter":
      return "content_filter"
    case undefined:
      return null
    default:
      // "error" and "unknown" have no OpenAI equivalent. Reporting them as
      // "stop" would tell the caller the turn ended cleanly when it did not.
      return reason
  }
}

/** The engine parses tool-call input; OpenAI clients expect a JSON string. */
export function toWireToolCalls(
  calls: ReadonlyArray<{ readonly id: string; readonly name: string; readonly input: unknown }>,
): ReadonlyArray<{
  readonly id: string
  readonly type: "function"
  readonly function: { readonly name: string; readonly arguments: string }
}> {
  return calls.map((call) => ({
    id: call.id,
    type: "function" as const,
    function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
  }))
}

/** `max_tokens` wins over `max_completion_tokens` when a caller sends both. */
export function toGeneration(request: ChatCompletionRequest): Record<string, unknown> | undefined {
  const generation: Record<string, unknown> = {}
  const maxTokens = request.max_tokens ?? request.max_completion_tokens
  if (maxTokens !== undefined) generation["maxTokens"] = maxTokens
  if (request.temperature !== undefined) generation["temperature"] = request.temperature
  if (request.top_p !== undefined) generation["topP"] = request.top_p
  if (request.seed !== undefined) generation["seed"] = request.seed
  if (request.frequency_penalty !== undefined) generation["frequencyPenalty"] = request.frequency_penalty
  if (request.presence_penalty !== undefined) generation["presencePenalty"] = request.presence_penalty
  if (request.stop !== undefined) {
    generation["stop"] = typeof request.stop === "string" ? [request.stop] : [...request.stop]
  }
  return Object.keys(generation).length > 0 ? generation : undefined
}
