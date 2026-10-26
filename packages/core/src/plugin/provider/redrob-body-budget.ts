// Byte budget for console.redrob.ai request bodies. See CONSOLE_MAX_BODY_BYTES in
// ./redrob-constants.ts for why: the console runs on Vercel, which rejects bodies over 2 MB (route
// limit) and ~4.5 MB (FUNCTION_PAYLOAD_TOO_LARGE) with 413, whatever the token count.
//
// Works on the OpenAI chat-completions body both engines send to the console (V2 native
// openai-compatible-chat route, V1 @ai-sdk/openai-compatible). Messages are never dropped or
// reordered, only their content is shrunk, so every assistant tool_call id still has its tool
// result and the history stays valid. Order, oldest message first within each step, stopping as soon
// as the body fits:
//   1. image/file parts in older messages -> a short text placeholder
//   2. long text in older messages (tool results, text, reasoning, tool-call arguments) -> head+tail
//      excerpt, first a generous one, then a tight one
//   3. the same two steps on the latest user message and the current step's tool results
// The system prompt and the tool definitions are never touched.

import { CONSOLE_MAX_BODY_BYTES } from "./redrob-constants"

type Json = Record<string, unknown>

const encoder = new TextEncoder()
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value) ?? "").length
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

const IMAGE_PLACEHOLDER = "[image omitted: request size limit]"
const FILE_PLACEHOLDER = "[file omitted: request size limit]"
const EXCERPTS = [
  { head: 2_000, tail: 1_000 },
  { head: 300, tail: 200 },
] as const

const excerpt = (text: string, head: number, tail: number) => {
  // Only cut when it saves more than the marker costs.
  if (text.length <= head + tail + 200) return undefined
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n\n[... ${omitted} characters omitted: request size limit ...]\n\n${text.slice(text.length - tail)}`
}

/** Shallow copy of one message, deep enough that shrinking it never mutates the caller's body. */
const copyMessage = (message: unknown): unknown => {
  if (!isRecord(message)) return message
  const next: Json = { ...message }
  if (Array.isArray(message.content)) next.content = [...message.content]
  if (Array.isArray(message.tool_calls))
    next.tool_calls = message.tool_calls.map((call) =>
      isRecord(call) && isRecord(call.function) ? { ...call, function: { ...call.function } } : call,
    )
  return next
}

/** Replaces non-text content parts with a text placeholder. Returns the bytes saved. */
const shrinkMedia = (message: Json) => {
  if (!Array.isArray(message.content)) return 0
  let saved = 0
  message.content = message.content.map((part) => {
    if (!isRecord(part) || part.type === "text") return part
    const image = part.type === "image_url" || part.type === "image"
    const placeholder = { type: "text", text: image ? IMAGE_PLACEHOLDER : FILE_PLACEHOLDER }
    saved += bytes(part) - bytes(placeholder)
    return placeholder
  })
  return saved
}

/** Cuts every long string in the message to a head+tail excerpt. Returns the bytes saved. */
const shrinkText = (message: Json, head: number, tail: number) => {
  let saved = 0
  const cut = (text: string) => {
    const next = excerpt(text, head, tail)
    if (next === undefined) return text
    saved += bytes(text) - bytes(next)
    return next
  }
  if (typeof message.content === "string") message.content = cut(message.content)
  if (Array.isArray(message.content))
    message.content = message.content.map((part) =>
      isRecord(part) && typeof part.text === "string" ? { ...part, text: cut(part.text) } : part,
    )
  if (typeof message.reasoning_content === "string") message.reasoning_content = cut(message.reasoning_content)
  if (Array.isArray(message.tool_calls))
    for (const call of message.tool_calls) {
      if (!isRecord(call) || !isRecord(call.function) || typeof call.function.arguments !== "string") continue
      const args = call.function.arguments
      const short = excerpt(args, head, tail)
      if (short === undefined) continue
      // Arguments must stay a JSON object for the upstream model API, so the excerpt is wrapped.
      const next = JSON.stringify({ omitted: "[arguments truncated: request size limit]", excerpt: short })
      saved += bytes(args) - bytes(next)
      call.function.arguments = next
    }
  return saved
}

/**
 * Returns `body` unchanged when its JSON fits `limit` bytes, otherwise a copy shrunk as described
 * at the top of this file. Applied by both engines right before a console request is sent, which
 * also covers the compaction request.
 */
export function budgetConsoleBody<T>(body: T, limit: number = CONSOLE_MAX_BODY_BYTES): T {
  if (!isRecord(body) || !Array.isArray(body.messages)) return body
  let size = bytes(body)
  if (size <= limit) return body

  const messages = body.messages.map(copyMessage)
  const role = (index: number) => {
    const message = messages[index]
    return isRecord(message) ? message.role : undefined
  }
  const protectedIndexes = new Set<number>()
  // The current step's tool results: the trailing run of tool messages.
  for (let index = messages.length - 1; index >= 0 && role(index) === "tool"; index--) protectedIndexes.add(index)
  for (let index = messages.length - 1; index >= 0; index--)
    if (role(index) === "user") {
      protectedIndexes.add(index)
      break
    }

  const older: number[] = []
  const latest: number[] = []
  messages.forEach((message, index) => {
    if (!isRecord(message) || message.role === "system" || message.role === "developer") return
    ;(protectedIndexes.has(index) ? latest : older).push(index)
  })

  const passes: Array<(message: Json) => number> = [
    shrinkMedia,
    ...EXCERPTS.map(({ head, tail }) => (message: Json) => shrinkText(message, head, tail)),
  ]
  shrink: for (const group of [older, latest])
    for (const pass of passes)
      for (const index of group) {
        if (size <= limit) break shrink
        size -= pass(messages[index] as Json)
      }

  return { ...body, messages } as T
}

/** String form for fetch wrappers: parses, budgets and re-encodes only when the body is over. */
export function budgetConsoleBodyText(text: string, limit: number = CONSOLE_MAX_BODY_BYTES): string {
  if (encoder.encode(text).length <= limit) return text
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return text
  }
  const next = budgetConsoleBody(parsed, limit)
  return next === parsed ? text : JSON.stringify(next)
}
