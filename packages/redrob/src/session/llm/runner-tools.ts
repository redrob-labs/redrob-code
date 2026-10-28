import type { LanguageModelV3Middleware, LanguageModelV3StreamPart } from "@ai-sdk/provider"

/**
 * Tool calls an agent runner already ran (Claude Code, Codex behind the desktop's local shim).
 *
 * Under provider option `providerExecutedTools: true` the provider streams each finished CLI tool call
 * as an OpenAI `choices[0].delta.tool_calls[*]` entry carrying `"provider_executed": true`, an optional
 * `"title"`, and `"result": { "output": string } | { "error": string }`. The openai-compatible parser
 * drops those extra fields and would hand the call to a local tool, so this middleware reads them from
 * the raw chunk instead, swallows the parser's own parts for those ids, and emits a provider-executed
 * `tool-call` + `tool-result` pair. The AI SDK then runs nothing locally and the session processor
 * stores them as completed (or errored) `tool` parts. Shape: docs/RUNNER-PROTOCOL.md.
 *
 * Needs `includeRawChunks: true` on the stream call; `forwardRaw` says whether the caller wanted the raw
 * parts itself.
 */
export function providerExecutedTools(forwardRaw: boolean): LanguageModelV3Middleware {
  return {
    specificationVersion: "v3",
    // The runner keeps its own record of the tools it ran; replaying them as OpenAI tool_calls with no
    // tool messages after them is a malformed history, so they leave the prompt.
    async transformParams({ params }) {
      return {
        ...params,
        prompt: params.prompt.map((message) =>
          message.role === "assistant"
            ? {
                ...message,
                content: message.content.filter(
                  (part) => !(part.type === "tool-call" && part.providerExecuted) && part.type !== "tool-result",
                ),
              }
            : message,
        ),
      }
    },
    async wrapStream({ doStream }) {
      const { stream, ...rest } = await doStream()
      const ran = new Set<string>()
      return {
        ...rest,
        stream: stream.pipeThrough(
          new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
            transform(part, controller) {
              if (part.type === "raw") {
                for (const call of runnerCalls(part.rawValue)) {
                  if (ran.has(call.id)) continue
                  ran.add(call.id)
                  controller.enqueue({
                    type: "tool-call",
                    toolCallId: call.id,
                    toolName: call.name,
                    input: call.input,
                    providerExecuted: true,
                    dynamic: true,
                  })
                  controller.enqueue(
                    call.error !== undefined
                      ? {
                          type: "tool-result",
                          toolCallId: call.id,
                          toolName: call.name,
                          result: call.error,
                          isError: true,
                          dynamic: true,
                        }
                      : {
                          type: "tool-result",
                          toolCallId: call.id,
                          toolName: call.name,
                          result: { title: call.title ?? call.name, output: call.output ?? "", metadata: {} },
                          dynamic: true,
                        },
                  )
                }
                if (forwardRaw) controller.enqueue(part)
                return
              }
              if (
                (part.type === "tool-input-start" || part.type === "tool-input-delta" || part.type === "tool-input-end") &&
                ran.has(part.id)
              )
                return
              if (part.type === "tool-call" && ran.has(part.toolCallId)) return
              controller.enqueue(part)
            },
          }),
        ),
      }
    },
  }
}

type RunnerCall = { id: string; name: string; input: string; title?: string; output?: string; error?: string }

function runnerCalls(raw: unknown): RunnerCall[] {
  if (!isRecord(raw) || !Array.isArray(raw.choices)) return []
  const calls: RunnerCall[] = []
  for (const choice of raw.choices) {
    if (!isRecord(choice) || !isRecord(choice.delta) || !Array.isArray(choice.delta.tool_calls)) continue
    for (const item of choice.delta.tool_calls) {
      if (!isRecord(item) || item.provider_executed !== true || typeof item.id !== "string") continue
      const fn = isRecord(item.function) ? item.function : {}
      const args = fn.arguments
      const result = isRecord(item.result) ? item.result : {}
      calls.push({
        id: item.id,
        name: typeof fn.name === "string" && fn.name ? fn.name : "tool",
        input: typeof args === "string" ? args : args === undefined ? "" : JSON.stringify(args),
        title: typeof item.title === "string" ? item.title : undefined,
        output: text(result.output),
        error: result.error === undefined || result.error === null ? undefined : (text(result.error) ?? "Error"),
      })
    }
  }
  return calls
}

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === "string" ? value : JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export * as LLMRunnerTools from "./runner-tools"
