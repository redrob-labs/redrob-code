/**
 * Contract: the OpenAI wire format converts to this engine's LLM schema without
 * inventing, dropping, or silently reinterpreting anything a caller sent.
 *
 * These are the conversions that carry the real risk on POST /v1/chat/completions,
 * because the format is fixed by clients that already exist and a mistranslation
 * is invisible: the request succeeds and the model is simply given something else
 * than the caller wrote.
 */
import { describe, expect, it } from "bun:test"
import type { ChatCompletionRequest } from "@redrob-code/protocol/groups/chat-completion"
import {
  ConversionError,
  toFinishReason,
  toGeneration,
  toLLMMessages,
  toLLMTools,
  toWireToolCalls,
} from "@redrob-code/server/handlers/chat-completion-wire"

const base = { model: "redrob/auto" } as const

function request(fields: Partial<ChatCompletionRequest>): ChatCompletionRequest {
  return { ...base, messages: [], ...fields } as ChatCompletionRequest
}

describe("messages", () => {
  it("carries a plain exchange through in order", () => {
    const messages = toLLMMessages(
      request({
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
      }),
    )
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant"])
    expect(messages[1]!.content).toEqual([{ type: "text", text: "hello" }])
  })

  it("treats developer as system, because OpenAI renamed the role and kept both", () => {
    const messages = toLLMMessages(request({ messages: [{ role: "developer", content: "rules" }] }))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe("system")
  })

  it("drops an empty message instead of sending a blank turn", () => {
    expect(toLLMMessages(request({ messages: [{ role: "system", content: "" }] }))).toHaveLength(0)
    expect(toLLMMessages(request({ messages: [{ role: "assistant", content: null }] }))).toHaveLength(0)
  })

  it("parses tool_call arguments, which arrive as a JSON string and must not stay one", () => {
    const messages = toLLMMessages(
      request({
        messages: [
          {
            role: "assistant",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } },
            ],
          },
        ],
      }),
    )
    const part = messages[0]!.content[0] as { type: string; id: string; name: string; input: unknown }
    expect(part.type).toBe("tool-call")
    expect(part.id).toBe("call_1")
    expect(part.input).toEqual({ path: "a.txt" })
  })

  it("keeps text and tool calls together on one assistant turn", () => {
    const messages = toLLMMessages(
      request({
        messages: [
          {
            role: "assistant",
            content: "let me look",
            tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
          },
        ],
      }),
    )
    expect(messages[0]!.content.map((part) => part.type)).toEqual(["text", "tool-call"])
  })

  it("refuses malformed tool_call arguments rather than forwarding an empty object", () => {
    // Silently sending {} would make the model answer a question nobody asked.
    expect(() =>
      toLLMMessages(
        request({
          messages: [
            {
              role: "assistant",
              tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{not json" } }],
            },
          ],
        }),
      ),
    ).toThrow(ConversionError)
  })

  it("refuses a tool message with no tool_call_id", () => {
    // The provider pairs the result to the call by this id; without it the model
    // sees an orphan result and there is nothing sensible to guess.
    expect(() => toLLMMessages(request({ messages: [{ role: "tool", content: "done" }] }))).toThrow(
      /requires tool_call_id/,
    )
  })

  it("carries a tool result under the id it answers", () => {
    const messages = toLLMMessages(
      request({ messages: [{ role: "tool", tool_call_id: "c1", name: "read", content: "file body" }] }),
    )
    const part = messages[0]!.content[0] as { type: string; id: string }
    expect(messages[0]!.role).toBe("tool")
    expect(part.type).toBe("tool-result")
    expect(part.id).toBe("c1")
  })

  it("accepts an array content part of type text", () => {
    const messages = toLLMMessages(
      request({ messages: [{ role: "user", content: [{ type: "text", text: "from a part" }] }] }),
    )
    expect(messages[0]!.content).toEqual([{ type: "text", text: "from a part" }])
  })

  it("refuses a content part it cannot carry instead of dropping it", () => {
    // An image silently discarded looks to the user like the model ignored it.
    expect(() =>
      toLLMMessages(
        request({
          messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:..." } }] }],
        }),
      ),
    ).toThrow(/not supported/)
  })
})

describe("tools", () => {
  it("is undefined when the caller declared none, which is what selects engine-owned tools", () => {
    expect(toLLMTools(request({}))).toBeUndefined()
    expect(toLLMTools(request({ tools: [] }))).toBeUndefined()
  })

  it("converts a declaration and passes parameters through untouched", () => {
    const parameters = { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    const tools = toLLMTools(
      request({ tools: [{ type: "function", function: { name: "read", description: "read a file", parameters } }] }),
    )
    expect(tools!.definitions).toHaveLength(1)
    expect(tools!.definitions[0]!.name).toBe("read")
    expect(tools!.definitions[0]!.inputSchema).toEqual(parameters)
  })

  it("gives a parameterless tool an empty object schema rather than dropping it", () => {
    const tools = toLLMTools(request({ tools: [{ type: "function", function: { name: "now" } }] }))
    expect(tools!.definitions[0]!.inputSchema).toEqual({ type: "object", properties: {} })
    // An invented description would put words in the prompt the caller never wrote.
    expect(tools!.definitions[0]!.description).toBe("")
  })

  it("carries tool_choice in both spellings", () => {
    expect(toLLMTools(request({ tools: [{ type: "function", function: { name: "a" } }], tool_choice: "none" }))!.choice).toBe(
      "none",
    )
    expect(
      toLLMTools(
        request({
          tools: [{ type: "function", function: { name: "a" } }],
          tool_choice: { type: "function", function: { name: "a" } },
        }),
      )!.choice,
    ).toEqual({ name: "a" })
  })
})

describe("finish reason", () => {
  it("maps the engine's vocabulary onto OpenAI's", () => {
    expect(toFinishReason("stop")).toBe("stop")
    expect(toFinishReason("length")).toBe("length")
    expect(toFinishReason("tool-calls")).toBe("tool_calls")
    expect(toFinishReason("content-filter")).toBe("content_filter")
    expect(toFinishReason(undefined)).toBeNull()
  })

  it("does not report a failed turn as a clean stop", () => {
    // "error" and "unknown" have no OpenAI equivalent. Reporting "stop" would
    // tell the caller the turn ended normally when it did not.
    expect(toFinishReason("error")).not.toBe("stop")
    expect(toFinishReason("unknown")).not.toBe("stop")
  })
})

describe("tool calls out", () => {
  it("re-stringifies input, because the engine parses it and clients expect a string", () => {
    const wire = toWireToolCalls([{ id: "c1", name: "read", input: { path: "a.txt" } }])
    expect(wire[0]!.function.arguments).toBe('{"path":"a.txt"}')
    expect(JSON.parse(wire[0]!.function.arguments)).toEqual({ path: "a.txt" })
    expect(wire[0]!.type).toBe("function")
  })

  it("emits {} for a call with no input, never undefined", () => {
    // `arguments: undefined` breaks a client that calls JSON.parse on it.
    expect(toWireToolCalls([{ id: "c1", name: "now", input: undefined }])[0]!.function.arguments).toBe("{}")
  })
})

describe("generation options", () => {
  it("is undefined when the caller set none", () => {
    expect(toGeneration(request({}))).toBeUndefined()
  })

  it("renames the wire fields to the engine's", () => {
    const generation = toGeneration(request({ max_tokens: 256, temperature: 0.2, top_p: 0.9 }))
    expect(generation).toEqual({ maxTokens: 256, temperature: 0.2, topP: 0.9 })
  })

  it("lets max_tokens win over max_completion_tokens when both are sent", () => {
    expect(toGeneration(request({ max_tokens: 100, max_completion_tokens: 900 }))!["maxTokens"]).toBe(100)
    expect(toGeneration(request({ max_completion_tokens: 900 }))!["maxTokens"]).toBe(900)
  })

  it("normalizes a single stop string to a list", () => {
    expect(toGeneration(request({ stop: "END" }))!["stop"]).toEqual(["END"])
    expect(toGeneration(request({ stop: ["A", "B"] }))!["stop"]).toEqual(["A", "B"])
  })
})
