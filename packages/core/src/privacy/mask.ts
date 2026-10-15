export * as Mask from "./mask"

import type { ContentPart, LLMEvent, LLMRequest, Message } from "@redrob-code/llm"
import type { ConfigPrivacy } from "../config/privacy"

/**
 * Replaces personal data in a request with placeholders, and puts it back in the answer.
 *
 * One Vault per session. A value gets one placeholder for the life of the process, so the model sees
 * the same `[PERSON_1]` in turn one and turn five and can refer back to it; the real value never goes
 * out and comes back in every text delta and every tool-call input the model produces, so tools run
 * on the real thing and the person reads the real thing.
 *
 * ponytail: the vault lives in memory. After a restart an old value gets a fresh index, which costs
 * the model one cross-reference and nothing else. Persist it if that ever matters.
 */

export type Kind = "EMAIL" | "PHONE" | "CARD" | "RRN" | "PERSON" | "ORG" | "LOC"

/** A found span: what text, and what kind of thing it is. */
export type Entity = { readonly value: string; readonly kind: Kind }

/* ------------------------------------------------------------------ detectors (regex tier) */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/* +82 10-1234-5678, 010-1234-5678, (02) 123-4567, +1 415 555 0100 -- 9 to 15 digits with separators. */
const PHONE = /(?<![\d-])(?:\+?\d{1,3}[ -]?)?(?:\(?0?\d{1,3}\)?[ -]?)\d{3,4}[ -]\d{4}(?![\d-])/g
/* 13 to 19 digits in groups; accepted only when Luhn-valid, so an order number does not get eaten. */
const CARD = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g
/* Korean resident registration number: YYMMDD-GNNNNNN. */
const RRN = /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])-?[1-8]\d{6}(?!\d)/g

const luhn = (digits: string) => {
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = Number(digits[index])
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

/** The regex tier: what can be found without a model. Order matters -- RRN before PHONE, so a resident number is not read as a phone number. */
export const detect = (text: string): Entity[] => {
  const found: Entity[] = []
  for (const match of text.matchAll(EMAIL)) found.push({ value: match[0], kind: "EMAIL" })
  for (const match of text.matchAll(RRN)) found.push({ value: match[0], kind: "RRN" })
  for (const match of text.matchAll(CARD)) {
    if (luhn(match[0].replace(/\D/g, ""))) found.push({ value: match[0], kind: "CARD" })
  }
  for (const match of text.matchAll(PHONE)) found.push({ value: match[0], kind: "PHONE" })
  return found
}

/* ------------------------------------------------------------------ vault */

const PLACEHOLDER = /\[(EMAIL|PHONE|CARD|RRN|PERSON|ORG|LOC)_(\d+)\]/g
/* A placeholder cut off by a chunk boundary: `[`, `[PER`, `[PERSON_`, `[PERSON_1`. */
const PARTIAL = /\[(?:[A-Z]{0,6}(?:_\d*)?)?$/

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export class Vault {
  private readonly forward = new Map<string, string>()
  private readonly backward = new Map<string, string>()
  private readonly counters = new Map<Kind, number>()

  /** Teach the vault a value; returns its placeholder (the same one every time). */
  add(entity: Entity): string {
    const known = this.forward.get(entity.value)
    if (known) return known
    const next = (this.counters.get(entity.kind) ?? 0) + 1
    this.counters.set(entity.kind, next)
    const placeholder = `[${entity.kind}_${next}]`
    this.forward.set(entity.value, placeholder)
    this.backward.set(placeholder, entity.value)
    return placeholder
  }

  get size() {
    return this.forward.size
  }

  private readonly scanned = new Set<string>()

  /** The texts the model tier has not read yet; marks them read. Keeps the local call to the new turn, not the whole history. */
  fresh(texts: readonly string[]): string[] {
    const result = texts.filter((text) => !this.scanned.has(text))
    for (const text of result) this.scanned.add(text)
    return result
  }

  /** Replace every known value in `text` by its placeholder. Longest value first, so a name inside an email is not half-replaced. */
  mask(text: string): string {
    if (this.forward.size === 0) return text
    const values = [...this.forward.keys()].sort((a, b) => b.length - a.length)
    return text.replace(new RegExp(values.map(escape).join("|"), "g"), (value) => this.forward.get(value) ?? value)
  }

  /** Detect with the regex tier, teach, then mask. */
  maskText(text: string): string {
    for (const entity of detect(text)) this.add(entity)
    return this.mask(text)
  }

  unmask(text: string): string {
    if (this.backward.size === 0) return text
    return text.replace(PLACEHOLDER, (placeholder) => this.backward.get(placeholder) ?? placeholder)
  }

  /**
   * Unmask a stream of text chunks. A placeholder can be split across two deltas (`[PERSON_` +
   * `1]`), so a trailing partial is held back and prepended to the next chunk; `flush` returns it
   * when the block ends.
   */
  unmasker() {
    let carry = ""
    return {
      push: (chunk: string): string => {
        const text = carry + chunk
        const partial = PARTIAL.exec(text)
        carry = partial ? partial[0] : ""
        return this.unmask(partial ? text.slice(0, partial.index) : text)
      },
      flush: (): string => {
        const rest = carry
        carry = ""
        return rest
      },
    }
  }

  /** Walk any JSON-ish value and unmask every string in it (tool-call inputs). */
  unmaskDeep<T>(value: T): T {
    if (typeof value === "string") return this.unmask(value) as T
    if (Array.isArray(value)) return value.map((item) => this.unmaskDeep(item)) as T
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.unmaskDeep(item)])) as T
    return value
  }
}

/* ------------------------------------------------------------------ request / event mapping */

const maskPart = (vault: Vault, part: ContentPart): ContentPart => {
  if (part.type === "text") return { ...part, text: vault.maskText(part.text) }
  if (part.type === "tool-result" && part.result.type === "text" && typeof part.result.value === "string")
    return { ...part, result: { ...part.result, value: vault.maskText(part.result.value) } }
  /* ponytail: json tool results and media are passed through. Mask them when a tool is found to leak. */
  return part
}

/** The request as the provider will see it. The system prompt is ours and is left alone. */
export const maskRequest = (vault: Vault, request: LLMRequest): LLMRequest => {
  const messages: Message[] = request.messages.map((message) => ({
    ...message,
    content: message.content.map((part) => maskPart(vault, part)),
  }))
  return { ...request, messages }
}

/** The texts of a request a model-tier detector should read: user and tool text, never the system prompt. */
export const readableTexts = (request: LLMRequest): string[] =>
  request.messages
    .flatMap((message) => message.content)
    .flatMap((part) => {
      if (part.type === "text") return [part.text]
      if (part.type === "tool-result" && part.result.type === "text" && typeof part.result.value === "string")
        return [part.result.value]
      return []
    })

/**
 * Put real values back into what the model produced. Text deltas go through a per-block unmasker;
 * tool-call inputs are unmasked whole, because the tool is about to run on them.
 */
export const unmaskEvents = (vault: Vault) => {
  const blocks = new Map<string, ReturnType<Vault["unmasker"]>>()
  return (event: LLMEvent): LLMEvent[] => {
    if (event.type === "text-delta") {
      const block = blocks.get(event.id) ?? vault.unmasker()
      blocks.set(event.id, block)
      return [{ ...event, text: block.push(event.text) }]
    }
    if (event.type === "text-end") {
      const rest = blocks.get(event.id)?.flush() ?? ""
      blocks.delete(event.id)
      return rest ? [{ type: "text-delta", id: event.id, text: vault.unmask(rest) }, event] : [event]
    }
    if (event.type === "tool-call") return [{ ...event, input: vault.unmaskDeep(event.input) }]
    return [event]
  }
}

/* ------------------------------------------------------------------ settings */

export type Settings = { readonly mode: ConfigPrivacy.Mode; readonly model?: string }

export const settings = (entries: readonly { readonly info?: { readonly privacy?: ConfigPrivacy.Info } }[]): Settings =>
  entries.reduce<Settings>(
    (result, entry) => ({
      mode: entry.info?.privacy?.mask_pii ?? result.mode,
      model: entry.info?.privacy?.model ?? result.model,
    }),
    { mode: "off" },
  )

/* ------------------------------------------------------------------ model tier */

/** What the local model is asked. JSON only, so the answer parses or is ignored. */
export const ENTITY_PROMPT = `List every personal name, organisation name and street address or place name that identifies a person in the text below. Answer with JSON only, in this exact shape and nothing else:
{"PERSON":["..."],"ORG":["..."],"LOC":["..."]}
Copy each value exactly as written in the text. Use empty arrays when there is none.

TEXT:
`

/** Parse the local model's answer. Anything that is not the asked-for shape is ignored, never trusted. */
export const parseEntities = (answer: string): Entity[] => {
  const start = answer.indexOf("{")
  const end = answer.lastIndexOf("}")
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(answer.slice(start, end + 1))
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object") return []
  const kinds: Kind[] = ["PERSON", "ORG", "LOC"]
  return kinds.flatMap((kind) => {
    const values = (parsed as Record<string, unknown>)[kind]
    return Array.isArray(values)
      ? values
          .filter((value): value is string => typeof value === "string" && value.trim().length > 1)
          .map((value) => ({ value: value.trim(), kind }))
      : []
  })
}
