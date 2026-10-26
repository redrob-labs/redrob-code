// Size budget for console.redrob.ai request bodies. Two limits apply:
//   - bytes: CONSOLE_MAX_BODY_BYTES in ./redrob-constants.ts. The console runs on Vercel, which
//     rejects bodies over 2 MB (route limit) and ~4.5 MB (FUNCTION_PAYLOAD_TOO_LARGE) with 413.
//   - characters: some console models (Redrob Free) cap the whole conversation at N characters,
//     counting an inline image or audio clip at the size of its base64 payload. The console says
//     so in a 400 ("... longer than this model accepts (81,920 characters across all messages
//     ..."). The limit is learned from that message per model (rememberConsoleCharLimit) and every
//     later request to that model, compaction included, is budgeted to 90% of it before sending.
//
// Works on the OpenAI chat-completions body both engines send to the console (V2 native
// openai-compatible-chat route, V1 @ai-sdk/openai-compatible). Messages are never dropped or
// reordered, only their content is shrunk, so every assistant tool_call id still has its tool
// result and the history stays valid. Order, oldest message first within each step, stopping as soon
// as the body fits:
//   0. with a known character limit, an image whose payload is over 60% of it is replaced by a note
//      telling the model why it cannot see the image (it can still answer from the file name)
//   1. image/file parts in older messages -> a short text placeholder
//   2. long text in older messages (tool results, text, reasoning, tool-call arguments) -> head+tail
//      excerpt, first a generous one, then a tight one
//   3. the same two steps on the latest user message and the current step's tool results (an image
//      there becomes the note from step 0)
// The system prompt and the tool definitions are never touched.

import { CONSOLE_MAX_BODY_BYTES } from "./redrob-constants"

type Json = Record<string, unknown>

/** `bytes`: JSON body size limit. `modelChars`: the model's character limit as the console states it. */
export interface ConsoleBudget {
  readonly bytes?: number
  readonly modelChars?: number
}

const encoder = new TextEncoder()
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value) ?? "").length
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

const IMAGE_PLACEHOLDER = "[image omitted: request size limit]"
const FILE_PLACEHOLDER = "[file omitted: request size limit]"
const EXCERPTS = [
  { head: 2_000, tail: 1_000 },
  { head: 300, tail: 200 },
] as const
/** Share of the model's character limit the request is budgeted to. */
const CHAR_BUDGET_SHARE = 0.9
/** An image over this share of the model's character limit is sent as a note up front. */
const IMAGE_NOTE_SHARE = 0.6

// ---- learned per-model character limits ------------------------------------------------------

const charLimits = new Map<string, number>()
const limitKey = (model: string) => `redrob/${model}`

/** Remembers, for this process, the character limit the console reported for `model`. */
export function rememberConsoleCharLimit(model: string, limit: number) {
  charLimits.set(limitKey(model), limit)
}

export function consoleCharLimit(model: unknown): number | undefined {
  return typeof model === "string" ? charLimits.get(limitKey(model)) : undefined
}

/** Test hook. */
export function forgetConsoleCharLimits() {
  charLimits.clear()
}

const LENGTH_OVERFLOW = /longer than this model accepts|characters across all messages/i

/** The model's character limit from a console "conversation is longer than this model accepts" error. */
export function parseConsoleCharLimit(text: string): number | undefined {
  if (!LENGTH_OVERFLOW.test(text)) return undefined
  const match = /\(\s*([\d,]+)\s+characters/i.exec(text)
  if (!match) return undefined
  const limit = Number(match[1]!.replaceAll(",", ""))
  return Number.isFinite(limit) && limit > 0 ? limit : undefined
}

// ---- measuring -------------------------------------------------------------------------------

const dataPayload = (url: string) => {
  const comma = url.indexOf(",")
  return url.startsWith("data:") && comma >= 0 ? url.slice(comma + 1) : url
}

const isMedia = (part: Json) => part.type !== "text"

/** Characters of one content part the way the console counts them (text, or base64 payload). */
const partChars = (part: unknown): number => {
  if (!isRecord(part)) return 0
  if (typeof part.text === "string") return part.text.length
  if (isRecord(part.image_url) && typeof part.image_url.url === "string") return dataPayload(part.image_url.url).length
  if (isRecord(part.input_audio) && typeof part.input_audio.data === "string") return part.input_audio.data.length
  if (isRecord(part.file) && typeof part.file.file_data === "string") return dataPayload(part.file.file_data).length
  return 0
}

const messageChars = (message: unknown): number => {
  if (!isRecord(message)) return 0
  let count = 0
  if (typeof message.content === "string") count += message.content.length
  if (Array.isArray(message.content)) for (const part of message.content) count += partChars(part)
  if (typeof message.reasoning_content === "string") count += message.reasoning_content.length
  if (Array.isArray(message.tool_calls))
    for (const call of message.tool_calls)
      if (isRecord(call) && isRecord(call.function) && typeof call.function.arguments === "string")
        count += call.function.arguments.length
  return count
}

const formatSize = (base64Chars: number) => {
  const size = Math.floor((base64Chars * 3) / 4)
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  if (size >= 1024) return `${Math.round(size / 1024)} KB`
  return `${size} bytes`
}

/** Text the model gets instead of an image too large for its character limit. */
export function consoleImageNote(name: string, payloadChars: number, modelChars: number) {
  return (
    `[image not sent: ${name} is ${formatSize(payloadChars)} and this model accepts about ` +
    `${modelChars.toLocaleString("en-US")} characters; describe what you can from the file name/metadata, ` +
    `or ask the user to pick a model that reads images]`
  )
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

/**
 * File names for the media parts of `messages[index]`, in order. Tool-result images reach the
 * console as a user message right after the tool results, without a name, so the names come from
 * the path arguments of the nearest preceding assistant tool calls (the read tool's filePath).
 */
const mediaNames = (messages: unknown[], index: number): string[] => {
  for (let at = index - 1; at >= 0; at--) {
    const message = messages[at]
    if (!isRecord(message) || message.role !== "assistant") continue
    if (!Array.isArray(message.tool_calls)) return []
    const names: string[] = []
    for (const call of message.tool_calls) {
      if (!isRecord(call) || !isRecord(call.function) || typeof call.function.arguments !== "string") continue
      try {
        const args: unknown = JSON.parse(call.function.arguments)
        if (!isRecord(args)) continue
        const path = args.filePath ?? args.file_path ?? args.path
        if (typeof path === "string" && path) names.push(baseName(path))
      } catch {}
    }
    return names
  }
  return []
}

const partName = (part: Json, names: string[], ordinal: number) => {
  if (isRecord(part.file) && typeof part.file.filename === "string") return part.file.filename
  return names[ordinal] ?? "the image"
}

// ---- shrinking -------------------------------------------------------------------------------

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

/** Returns the text a media part is replaced with, or undefined to keep it. */
type MediaReplacement = (part: Json, ordinal: number) => string | undefined

/** Replaces media content parts as `replace` says. Returns the bytes saved. */
const shrinkMedia = (message: Json, replace: MediaReplacement) => {
  if (!Array.isArray(message.content)) return 0
  let saved = 0
  let ordinal = 0
  message.content = message.content.map((part) => {
    if (!isRecord(part) || !isMedia(part)) return part
    const text = replace(part, ordinal++)
    if (text === undefined) return part
    const next = { type: "text", text }
    saved += bytes(part) - bytes(next)
    return next
  })
  return saved
}

const placeholder: MediaReplacement = (part) =>
  part.type === "image_url" || part.type === "image" ? IMAGE_PLACEHOLDER : FILE_PLACEHOLDER

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

const resolveBudget = (body: Json, limit: number | ConsoleBudget | undefined) => {
  if (typeof limit === "number") return { bytes: limit, modelChars: undefined }
  return {
    bytes: limit?.bytes ?? CONSOLE_MAX_BODY_BYTES,
    // No explicit limit: use the one learned for this model, if any.
    modelChars: limit === undefined ? consoleCharLimit(body.model) : limit.modelChars,
  }
}

/**
 * Returns `body` unchanged when it fits, otherwise a copy shrunk as described at the top of this
 * file. `limit` is a byte limit, or both limits; omitted, it is CONSOLE_MAX_BODY_BYTES plus the
 * character limit learned for `body.model`. Applied by both engines right before a console request
 * is sent, which also covers the compaction request.
 */
export function budgetConsoleBody<T>(body: T, limit?: number | ConsoleBudget): T {
  if (!isRecord(body) || !Array.isArray(body.messages)) return body
  const budget = resolveBudget(body, limit)
  const modelChars = budget.modelChars
  const charBudget = modelChars === undefined ? Infinity : Math.floor(modelChars * CHAR_BUDGET_SHARE)
  const original = body.messages
  let size = bytes(body)
  let chars = modelChars === undefined ? 0 : original.reduce<number>((sum, message) => sum + messageChars(message), 0)
  const fits = () => size <= budget.bytes && chars <= charBudget

  const oversized =
    modelChars !== undefined &&
    original.some(
      (message) =>
        isRecord(message) &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) => isRecord(part) && isMedia(part) && partChars(part) > modelChars * IMAGE_NOTE_SHARE,
        ),
    )
  if (fits() && !oversized) return body

  const messages = original.map(copyMessage)
  const role = (index: number) => {
    const message = messages[index]
    return isRecord(message) ? message.role : undefined
  }
  const note =
    (index: number): MediaReplacement =>
    (part, ordinal) =>
      modelChars === undefined
        ? placeholder(part, ordinal)
        : consoleImageNote(partName(part, mediaNames(messages, index), ordinal), partChars(part), modelChars)
  const apply = (index: number, pass: (message: Json) => number) => {
    const message = messages[index] as Json
    const before = modelChars === undefined ? 0 : messageChars(message)
    size -= pass(message)
    if (modelChars !== undefined) chars -= before - messageChars(message)
  }

  if (oversized)
    messages.forEach((message, index) => {
      if (!isRecord(message) || !Array.isArray(message.content)) return
      const replace = note(index)
      apply(index, (target) =>
        shrinkMedia(target, (part, ordinal) =>
          partChars(part) > modelChars! * IMAGE_NOTE_SHARE ? replace(part, ordinal) : undefined,
        ),
      )
    })

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

  const textPasses = EXCERPTS.map(
    ({ head, tail }) =>
      (_index: number) =>
      (message: Json) =>
        shrinkText(message, head, tail),
  )
  const groups = [
    { indexes: older, media: (_index: number) => placeholder },
    { indexes: latest, media: note },
  ]
  shrink: for (const group of groups) {
    const passes = [(index: number) => (message: Json) => shrinkMedia(message, group.media(index)), ...textPasses]
    for (const pass of passes)
      for (const index of group.indexes) {
        if (fits()) break shrink
        apply(index, pass(index))
      }
  }

  return { ...body, messages } as T
}

/** String form for fetch wrappers: parses, budgets and re-encodes only when it may be over. */
export function budgetConsoleBodyText(text: string, limit?: number | ConsoleBudget): string {
  const byteLimit = typeof limit === "number" ? limit : (limit?.bytes ?? CONSOLE_MAX_BODY_BYTES)
  const charsMayApply =
    typeof limit === "object" ? limit.modelChars !== undefined : limit === undefined && charLimits.size > 0
  if (!charsMayApply && encoder.encode(text).length <= byteLimit) return text
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return text
  }
  const next = budgetConsoleBody(parsed, limit)
  return next === parsed ? text : JSON.stringify(next)
}

const modelOf = (text: string) => {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) && typeof parsed.model === "string" ? parsed.model : undefined
  } catch {
    return undefined
  }
}

/**
 * Sends a console request budgeted to the limits known for its model. When the console answers
 * 400/413 "longer than this model accepts (N characters ...)", N is remembered for the model and
 * the same request is re-sent once, budgeted to it, before the error is handed back (the session
 * runner then compacts, which this budget also covers). Used by both V1 fetch wrappers.
 */
export async function sendConsoleBudgeted(text: string, send: (body: string) => Promise<Response>) {
  const first = budgetConsoleBodyText(text)
  const response = await send(first)
  if (response.status !== 400 && response.status !== 413) return response
  const limit = parseConsoleCharLimit(
    await response
      .clone()
      .text()
      .catch(() => ""),
  )
  const model = limit === undefined ? undefined : modelOf(text)
  if (limit === undefined || model === undefined) return response
  rememberConsoleCharLimit(model, limit)
  const retry = budgetConsoleBodyText(text, { modelChars: limit })
  if (retry === first) return response
  return send(retry)
}
