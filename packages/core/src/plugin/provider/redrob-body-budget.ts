// Size budget for console.redrob.ai request bodies. Two limits apply:
//   - bytes: CONSOLE_MAX_BODY_BYTES in ./redrob-constants.ts. The console runs on Vercel, which
//     rejects bodies over 2 MB (route limit) and ~4.5 MB (FUNCTION_PAYLOAD_TOO_LARGE) with 413.
//   - characters: some console models (Redrob Free) cap the whole conversation at N characters,
//     counting an inline image or audio clip at the size of its base64 payload. The console says
//     so in a 400 ("... longer than this model accepts (81,920 characters across all messages
//     ...)"). The limit is learned from that message per model id (rememberConsoleCharLimit) for 10
//     minutes, and every later request to that same id, compaction included, is budgeted to 90% of
//     it before sending. A router id (`auto`: the console picks the real model per request) is never
//     remembered, because one request routed to a small model says nothing about the next one; that
//     request alone is re-sent, budgeted to the limit it reported.
//
// Works on the OpenAI chat-completions body both engines send to the console (V2 native
// openai-compatible-chat route, V1 @ai-sdk/openai-compatible). Messages are never dropped or
// reordered, only their content is shrunk, so every assistant tool_call id still has its tool
// result and the history stays valid. Order, oldest message first within each step, stopping as soon
// as the body fits:
//   0. with a known character limit, an image whose payload is over 60% of it is replaced by a note
//      telling the model why it cannot see the image (consoleImageNote)
//   1. image/file parts in older messages -> the same note for an image, a placeholder for a file
//   2. long text in older messages (tool results, text, reasoning, tool-call arguments) -> head+tail
//      excerpt, first a generous one, then a tight one
//   3. the same two steps on the latest user message and the current step's tool results
// The system prompt and the tool definitions are never touched.
//
// Images first try a model that can see them (routeConsoleBody): when the selected model cannot
// take an image (the listing says so) or the budget would replace one, that one request goes to a
// vision model instead (consoleVisionModel), budgeted to that model's own limits, and the next
// request goes back to the selected model. Only when no vision model can carry more of the images
// does the note go in.

import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { CONSOLE_MAX_BODY_BYTES } from "./redrob-constants"

type Json = Record<string, unknown>

/** `bytes`: JSON body size limit. `modelChars`: the model's character limit as the console states it. */
export interface ConsoleBudget {
  readonly bytes?: number
  readonly modelChars?: number
  /** Replace every image with the note: the model cannot take images at all. */
  readonly noImages?: boolean
}

/** Limits for routeConsoleBody: per model id, on top of the learned ones. */
export interface ConsoleRouteBudget {
  readonly bytes?: number
  readonly charsByModel?: Readonly<Record<string, number>>
}

const encoder = new TextEncoder()
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value) ?? "").length
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

const FILE_PLACEHOLDER = "[file omitted: request size limit]"
const EXCERPTS = [
  { head: 2_000, tail: 1_000 },
  { head: 300, tail: 200 },
] as const
/** Share of the model's character limit the request is budgeted to. */
const CHAR_BUDGET_SHARE = 0.9
/** An image over this share of the model's character limit is sent as a note up front. */
const IMAGE_NOTE_SHARE = 0.6
/** How long a learned character limit is trusted. */
export const CHAR_LIMIT_TTL_MS = 10 * 60_000

let clock = () => Date.now()
/** Test hook: the clock the limit TTL reads. Omit to restore the real one. */
export function setConsoleBudgetClock(now?: () => number) {
  clock = now ?? (() => Date.now())
}

// ---- console models: router ids, image input, the vision model ---------------------------------

/** What the console listing says about one model id. */
export interface ConsoleModelFacts {
  readonly id: string
  /** Accepts image input. Undefined: the listing did not say. */
  readonly image?: boolean
  /** A router id: the console picks the real model per request. */
  readonly routed?: boolean
}

const listing = new Map<string, ConsoleModelFacts>()

/** Records the console listing, in its order (ModelsDev calls it on every fetch). */
export function rememberConsoleModels(models: Iterable<ConsoleModelFacts>) {
  listing.clear()
  for (const model of models) listing.set(model.id, model)
}

const ROUTER_ID = /^(?:redrob-)?auto(?:[-_].*)?$/i

/** A router id: listed as routed, or named `auto` / `redrob-auto` / `auto-*`. */
export function isConsoleRouterModel(model: string) {
  return listing.get(model)?.routed === true || ROUTER_ID.test(model)
}

/** Whether the listing says `model` takes images; undefined when it does not say. */
export function consoleImageInput(model: string): boolean | undefined {
  return listing.get(model)?.image
}

/**
 * Known console ids that read images, used only when the listing publishes no image flag. Kept to
 * ids the listing also serves, so a retired id is never picked.
 */
export const KNOWN_VISION_MODEL_IDS = ["claude-sonnet-5", "claude-opus-5", "gpt-5.6-sol"] as const

const settingsFile = () => path.join(process.env.REDROB_TEST_HOME ?? os.homedir(), ".redrob", "desk", "settings.json")
let configuredVision: (() => string | undefined) | undefined
let settingsCache: { at: number; value: string | undefined } | undefined

/** `visionModel` from `~/.redrob/desk/settings.json` (the launcher's desk settings), read at most every 5 s. */
const deskVisionModel = () => {
  if (configuredVision) return configuredVision()
  const now = clock()
  if (settingsCache && now - settingsCache.at < 5_000) return settingsCache.value
  let value: string | undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsFile(), "utf8"))
    const raw = isRecord(parsed) ? parsed.visionModel : undefined
    value = typeof raw === "string" && raw.trim() ? raw.trim() : undefined
  } catch {}
  settingsCache = { at: now, value }
  return value
}

/** Test hook: replaces the `desk.visionModel` setting. Omit to read the settings file again. */
export function setConsoleVisionSetting(read?: () => string | undefined) {
  configuredVision = read
  settingsCache = undefined
}

/**
 * The model one request with images goes to when `current` cannot take them: the `desk.visionModel`
 * setting, else the first listed model that takes images, else a known vision id the listing serves.
 * Never `current` itself, and never a router id (it could route to a model without images).
 */
export function consoleVisionModel(current: string): string | undefined {
  const usable = (id: string | undefined): id is string =>
    id !== undefined && id !== current && consoleImageInput(id) !== false && !isConsoleRouterModel(id)
  const setting = deskVisionModel()
  if (usable(setting)) return setting
  for (const model of listing.values()) if (model.image === true && usable(model.id)) return model.id
  for (const id of KNOWN_VISION_MODEL_IDS) if (listing.has(id) && usable(id)) return id
  return undefined
}

// ---- learned per-model character limits ------------------------------------------------------

const charLimits = new Map<string, { limit: number; at: number }>()
const limitKey = (model: string) => `redrob/${model}`

/**
 * Remembers, for 10 minutes in this process, the character limit the console reported for `model`.
 * A router id is not remembered (returns false): the limit belonged to whichever model it routed to.
 */
export function rememberConsoleCharLimit(model: string, limit: number) {
  if (isConsoleRouterModel(model)) return false
  charLimits.set(limitKey(model), { limit, at: clock() })
  return true
}

export function consoleCharLimit(model: unknown): number | undefined {
  if (typeof model !== "string") return undefined
  const key = limitKey(model)
  const entry = charLimits.get(key)
  if (!entry) return undefined
  if (clock() - entry.at > CHAR_LIMIT_TTL_MS) {
    charLimits.delete(key)
    return undefined
  }
  return entry.limit
}

/** Test hook. */
export function forgetConsoleCharLimits() {
  charLimits.clear()
  listing.clear()
  configuredVision = undefined
  settingsCache = undefined
  clock = () => Date.now()
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
const isImage = (part: Json) => part.type === "image_url" || part.type === "image"

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

/** Image parts left in `messages`. */
const imageCount = (messages: unknown[]) => {
  let count = 0
  for (const message of messages)
    if (isRecord(message) && Array.isArray(message.content))
      for (const part of message.content) if (isRecord(part) && isImage(part)) count++
  return count
}

/**
 * Text the model gets instead of an image it cannot see, on every path (no image input, the
 * character or byte limit, no vision model): it must not try to OCR the file, and the user already
 * sees the image in the chat.
 */
export function consoleImageNote(name: string) {
  return (
    `[This model cannot view the image: ${name}. Do not try to read it with OCR or any other tool. ` +
    `Tell the user the image is already shown to them in the chat, and that switching to a model that ` +
    `can see images would let you describe it.]`
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
  if (typeof limit === "number") return { bytes: limit, modelChars: undefined, noImages: false }
  return {
    bytes: limit?.bytes ?? CONSOLE_MAX_BODY_BYTES,
    // No explicit limit: use the one learned for this model id, if any.
    modelChars: limit === undefined ? consoleCharLimit(body.model) : limit.modelChars,
    noImages: limit?.noImages === true,
  }
}

/**
 * Returns `body` unchanged when it fits, otherwise a copy shrunk as described at the top of this
 * file. `limit` is a byte limit, or both limits; omitted, it is CONSOLE_MAX_BODY_BYTES plus the
 * character limit learned for `body.model`.
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

  // An image that goes as a note before any other shrinking: every image when the model takes
  // none, else one over 60% of a known character limit.
  const upFront = (part: Json) =>
    isImage(part) && (budget.noImages || (modelChars !== undefined && partChars(part) > modelChars * IMAGE_NOTE_SHARE))
  const oversized = original.some(
    (message) =>
      isRecord(message) &&
      Array.isArray(message.content) &&
      message.content.some((part) => isRecord(part) && upFront(part)),
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
      isImage(part) ? consoleImageNote(partName(part, mediaNames(messages, index), ordinal)) : FILE_PLACEHOLDER
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
        shrinkMedia(target, (part, ordinal) => (upFront(part) ? replace(part, ordinal) : undefined)),
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
  shrink: for (const group of [older, latest]) {
    const passes = [(index: number) => (message: Json) => shrinkMedia(message, note(index)), ...textPasses]
    for (const pass of passes)
      for (const index of group) {
        if (fits()) break shrink
        apply(index, pass(index))
      }
  }

  return { ...body, messages } as T
}

// ---- routing images to a model that can see them ----------------------------------------------

/** A request moved to another model for one step because of its images. */
export interface ConsoleModelSwitch {
  readonly from: string
  readonly to: string
  readonly reason: "no-image-input" | "limit"
}

export interface ConsoleRoute<T> {
  readonly body: T
  readonly switched?: ConsoleModelSwitch
}

const budgetFor = (model: string, limit: ConsoleRouteBudget | undefined) => ({
  bytes: limit?.bytes ?? CONSOLE_MAX_BODY_BYTES,
  modelChars: limit?.charsByModel?.[model] ?? consoleCharLimit(model),
})

/**
 * Budgets `body` for its model, and when that would cost images (the model takes none, or the
 * budget replaces one), tries the same request on the vision model with that model's own limits.
 * The vision model wins only when it keeps more images; otherwise the notes go in.
 */
export function routeConsoleBody<T>(body: T, limit?: ConsoleRouteBudget): ConsoleRoute<T> {
  if (!isRecord(body) || !Array.isArray(body.messages) || typeof body.model !== "string")
    return { body: budgetConsoleBody(body, limit?.bytes) }
  const model = body.model
  const images = imageCount(body.messages)
  const blind = images > 0 && consoleImageInput(model) === false
  const own = budgetConsoleBody(body, { ...budgetFor(model, limit), noImages: blind }) as Json
  const kept = imageCount(own.messages as unknown[])
  if (images === 0 || kept === images) return { body: own as T }
  const vision = consoleVisionModel(model)
  if (vision) {
    const moved: Json = budgetConsoleBody({ ...body, model: vision } as Json, budgetFor(vision, limit))
    if (imageCount(moved.messages as unknown[]) > kept)
      return { body: moved as T, switched: { from: model, to: vision, reason: blind ? "no-image-input" : "limit" } }
  }
  return { body: own as T }
}

/** String form of routeConsoleBody: parses only when a limit or an image may apply. */
export function routeConsoleBodyText(text: string, limit?: ConsoleRouteBudget): ConsoleRoute<string> {
  const byteLimit = limit?.bytes ?? CONSOLE_MAX_BODY_BYTES
  const mayApply =
    charLimits.size > 0 ||
    limit?.charsByModel !== undefined ||
    text.includes('"image_url"') ||
    encoder.encode(text).length > byteLimit
  if (!mayApply) return { body: text }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { body: text }
  }
  const route = routeConsoleBody(parsed, limit)
  return route.body === parsed ? { body: text } : { body: JSON.stringify(route.body), switched: route.switched }
}

/** String form for fetch wrappers: parses, budgets and re-encodes only when it may be over. */
export function budgetConsoleBodyText(text: string, limit?: number | ConsoleBudget): string {
  const byteLimit = typeof limit === "number" ? limit : (limit?.bytes ?? CONSOLE_MAX_BODY_BYTES)
  const charsMayApply =
    typeof limit === "object"
      ? limit.modelChars !== undefined || limit.noImages === true
      : limit === undefined && charLimits.size > 0
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

/** One log line for a step that went to the vision model. */
export const describeConsoleSwitch = (change: ConsoleModelSwitch) =>
  `console: this step goes to ${change.to} instead of ${change.from} ` +
  `(${change.reason === "no-image-input" ? `${change.from} takes no images` : `the images do not fit ${change.from}'s limit`}); ` +
  `the next step goes back to ${change.from}`

/**
 * Sends a console request budgeted (and routed, for images) to the limits known for its model.
 * When the console answers 400/413 "longer than this model accepts (N characters ...)", N is
 * remembered for the model that was sent (not for a router id) and the same request is re-sent
 * once, budgeted to it, before the error is handed back (the session runner then compacts, which
 * this budget also covers). Used by both V1 fetch wrappers.
 */
export async function sendConsoleBudgeted(
  text: string,
  send: (body: string) => Promise<Response>,
  onSwitch?: (change: ConsoleModelSwitch) => void,
) {
  const first = routeConsoleBodyText(text)
  if (first.switched) onSwitch?.(first.switched)
  const response = await send(first.body)
  if (response.status !== 400 && response.status !== 413) return response
  const limit = parseConsoleCharLimit(
    await response
      .clone()
      .text()
      .catch(() => ""),
  )
  const model = limit === undefined ? undefined : modelOf(first.body)
  if (limit === undefined || model === undefined) return response
  const remembered = rememberConsoleCharLimit(model, limit)
  const retry = routeConsoleBodyText(text, remembered ? undefined : { charsByModel: { [model]: limit } })
  if (retry.body === first.body) return response
  if (retry.switched) onSwitch?.(retry.switched)
  return send(retry.body)
}
