/**
 * An OpenAI-compatible chat-completions server that plays a scripted model, so the real engine can
 * run whole agent turns in tests with no Console key and no network.
 *
 * Each "vendor" is a path prefix (`/acme/v1`, `/beta/v1`, ...). A request is answered by the first
 * rule whose `when` matches: a builder writes the file its rule names and then says it is done; a
 * reviewer answers with the JSON verdict its rule produces. Both streaming and non-streaming bodies
 * are served, because the AI SDK uses either depending on the call.
 */

export type ChatMessage = { role: string; content?: unknown; tool_calls?: unknown[] }

export type Reply =
  | { kind: "write"; filePath: string; content: string }
  | { kind: "writes"; files: { filePath: string; content: string }[] }
  | { kind: "text"; text: string }

export type Rule = {
  vendor: string
  when?: (messages: ChatMessage[]) => boolean
  reply: (messages: ChatMessage[]) => Reply
}

function text(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("")
  return ""
}

export const lastUser = (messages: ChatMessage[]) =>
  text([...messages].reverse().find((message) => message.role === "user")?.content)
export const allText = (messages: ChatMessage[]) => messages.map((message) => text(message.content)).join("\n")
export const hasToolResult = (messages: ChatMessage[]) => messages.some((message) => message.role === "tool")

export function startFakeLlm(rules: Rule[]) {
  const calls: { vendor: string; messages: ChatMessage[] }[] = []
  let sequence = 0

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const match = /^\/([^/]+)\/v1\/(chat\/completions|models)$/.exec(url.pathname)
      if (!match) return new Response("not found", { status: 404 })
      const vendor = match[1]!
      if (match[2] === "models") return Response.json({ object: "list", data: [] })

      const body = (await request.json()) as { messages: ChatMessage[]; stream?: boolean; model: string }
      calls.push({ vendor, messages: body.messages })
      const rule = rules.find((candidate) => candidate.vendor === vendor && (candidate.when?.(body.messages) ?? true))
      // One file per turn: a builder with N files writes them over N turns, then says it is done.
      const scripted = rule?.reply(body.messages) ?? { kind: "text" as const, text: "OK." }
      const toolResults = body.messages.filter((message) => message.role === "tool").length
      const reply: Reply =
        scripted.kind === "writes"
          ? toolResults < scripted.files.length
            ? { kind: "write", ...scripted.files[toolResults]! }
            : { kind: "text", text: "Done." }
          : hasToolResult(body.messages)
            ? { kind: "text", text: "Done." }
            : scripted
      const id = `chatcmpl-${++sequence}`
      const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }

      const message =
        reply.kind === "write"
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call_${sequence}`,
                  type: "function",
                  function: {
                    name: "write",
                    arguments: JSON.stringify({ path: reply.filePath, content: reply.content }),
                  },
                },
              ],
            }
          : { role: "assistant", content: reply.text }
      const finish = reply.kind === "write" ? "tool_calls" : "stop"

      if (!body.stream) {
        return Response.json({
          id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, message, finish_reason: finish }],
          usage,
        })
      }

      const chunks: unknown[] = []
      const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model }
      if (reply.kind === "write") {
        chunks.push({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  { index: 0, id: `call_${sequence}`, type: "function", function: { name: "write", arguments: "" } },
                ],
              },
              finish_reason: null,
            },
          ],
        })
        chunks.push({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: (message.tool_calls![0] as { function: { arguments: string } }).function.arguments,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })
      } else {
        chunks.push({
          ...base,
          choices: [{ index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null }],
        })
      }
      chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })
      const stream = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
    },
  })

  return {
    url: (vendor: string) => `http://127.0.0.1:${server.port}/${vendor}/v1`,
    calls,
    stop: () => server.stop(true),
  }
}
