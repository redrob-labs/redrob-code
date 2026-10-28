/**
 * W-5, first half: what counts as "substantially the same thing" across two past task prompts.
 *
 * Everything in this file is PURE — strings in, numbers and booleans out. No session, no storage,
 * no clock. That is deliberate: a matcher is only trustworthy if its negative cases can be pinned
 * by a unit test, and a matcher that needs a live session to run is a matcher nobody re-checks.
 *
 * The rule has four parts, and three of them exist to make it say NO:
 *
 *  1. The ACTION HEAD must be identical. "summarise my unread email" and "delete my unread email"
 *     share almost every word and are not the same request.
 *  2. NEGATION must agree. "deploy the staging site" and "do not deploy the staging site" are
 *     opposites built from the same tokens.
 *  3. There must be at least `minSharedContent` shared content words. Without this, two prompts
 *     made only of stopwords ("do it again" / "do that now") compare as two empty sets, and an
 *     empty-set overlap looks like a perfect match. It also means a one-content-word prompt
 *     ("deploy") never matches anything, which is intended: one word is too thin to offer to
 *     automate, however often it is repeated.
 *  4. Only then does the overlap score have to clear the threshold.
 *
 * Volatile tokens — bare numbers, dates, clock times, weekday and month names — are dropped before
 * comparing, because "run the report for Monday" and "run the report for Tuesday" are the SAME
 * repeated request. That is the one place where dropping information makes the matcher say yes
 * more often, and it is the point of the item.
 */

/** Words that carry no request-identity. Kept deliberately small: a long list hides real words. */
const STOPWORDS = new Set([
  "a",
  "about",
  "again",
  "all",
  "also",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "each",
  "every",
  "for",
  "from",
  "get",
  "go",
  "had",
  "has",
  "have",
  "he",
  "her",
  "him",
  "his",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "me",
  "mine",
  "my",
  "of",
  "on",
  "once",
  "one",
  "or",
  "our",
  "out",
  "over",
  "please",
  "pls",
  "she",
  "should",
  "so",
  "some",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "up",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "which",
  "while",
  "who",
  "will",
  "with",
  "would",
  "you",
  "your",
  "yours",
])

/** A mismatch in any of these flips the answer to "not the same thing", whatever the overlap is. */
const NEGATIONS = new Set([
  "cannot",
  "cant",
  "dont",
  "isnt",
  "never",
  "no",
  "none",
  "nor",
  "not",
  "stop",
  "without",
  "wont",
])

const WEEKDAYS = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "mon",
  "tue",
  "tues",
  "wed",
  "thu",
  "thur",
  "thurs",
  "fri",
  "sat",
  "sun",
  "today",
  "tomorrow",
  "yesterday",
  "tonight",
])

const MONTHS = new Set([
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
])

/** Bare numbers, ordinals, clock times, ISO dates — anything that changes per occurrence. */
const NUMERIC = /^(\d+(?:[.:\-/]\d+)*)(?:st|nd|rd|th|am|pm|h|m|s|%)?$/

const isVolatile = (token: string) =>
  NUMERIC.test(token) || WEEKDAYS.has(token) || MONTHS.has(token) || token === "am" || token === "pm"

/**
 * Splits a prompt into comparable tokens: lowercased, apostrophes closed up ("don't" -> "dont"),
 * everything else non-alphanumeric treated as a separator. A trailing plural "s" is folded so
 * "the open pull requests" and "the open pull request" are one request, which a stemmer would also
 * do and which no dependency is needed for.
 */
export const tokenize = (prompt: string): string[] =>
  prompt
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .split(/[^a-z0-9가-힣.:\-/]+/)
    .map((token) => token.replace(/^[.:\-/]+|[.:\-/]+$/g, ""))
    .filter((token) => token.length > 0)
    .map((token) => (token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token))

export interface Signature {
  /** Content words, de-duplicated and order-free. */
  readonly content: ReadonlySet<string>
  /** The first content word — the thing being asked for. Empty when the prompt has none. */
  readonly head: string
  /** Whether the prompt negates. */
  readonly negated: boolean
  /** Token count before stopword and volatile removal, for reporting only. */
  readonly length: number
}

/** PURE. The comparable shape of one prompt. */
export const signature = (prompt: string): Signature => {
  const tokens = tokenize(prompt)
  const content: string[] = []
  let negated = false
  for (const token of tokens) {
    if (NEGATIONS.has(token)) {
      negated = true
      continue
    }
    if (STOPWORDS.has(token)) continue
    if (isVolatile(token)) continue
    content.push(token)
  }
  return {
    content: new Set(content),
    head: content[0] ?? "",
    negated,
    length: tokens.length,
  }
}

export interface MatchOptions {
  /** Overlap the two prompts must reach, 0..1. Default 0.7. */
  readonly threshold?: number
  /** Content words the two must share outright. Default 2. */
  readonly minSharedContent?: number
}

const DEFAULTS = { threshold: 0.7, minSharedContent: 2 } as const

/**
 * PURE. Overlap of two prompts in 0..1: shared content words over their union.
 *
 * Union, not containment. Containment reads "deploy the staging site" and "deploy the production
 * site" as 0.67 because two of three words match, and those are not the same request — the word
 * that differs is the whole substance. Dividing by the union makes a single differing word cost
 * what it should: that pair scores 0.5 and is refused.
 *
 * Returns 0 — not a low score — when the heads differ or the negation differs, so no threshold can
 * ever be lowered far enough to match opposites.
 */
export const overlap = (a: string, b: string): number => {
  const left = signature(a)
  const right = signature(b)
  if (left.content.size === 0 || right.content.size === 0) return 0
  if (left.negated !== right.negated) return 0
  if (left.head !== right.head) return 0

  let shared = 0
  for (const token of left.content) if (right.content.has(token)) shared += 1
  const union = left.content.size + right.content.size - shared
  return union === 0 ? 0 : shared / union
}

/** PURE. How many content words two prompts have in common. */
export const sharedContent = (a: string, b: string): number => {
  const left = signature(a)
  const right = signature(b)
  let shared = 0
  for (const token of left.content) if (right.content.has(token)) shared += 1
  return shared
}

/**
 * PURE. Whether two past prompts are the same request asked twice.
 *
 * This is the function W-5's proposal rests on. It is intentionally strict: a false yes offers to
 * automate something the user never repeated, which is worse than missing a repetition.
 */
export const isSubstantiallySame = (a: string, b: string, options?: MatchOptions): boolean => {
  const threshold = options?.threshold ?? DEFAULTS.threshold
  const minShared = options?.minSharedContent ?? DEFAULTS.minSharedContent
  if (sharedContent(a, b) < minShared) return false
  return overlap(a, b) >= threshold
}

export interface Occurrence {
  /** Stable id of the thing the prompt came from, so a caller can point back at it. */
  readonly id: string
  readonly prompt: string
  /** Epoch millis. */
  readonly at: number
}

export interface Repetition {
  /**
   * Stable identity of the repeated request, derived from the content the occurrences agree on.
   * The same repetition seen again produces the same key, which is what lets a decline be
   * remembered across restarts.
   */
  readonly key: string
  /** The occurrences, oldest first. */
  readonly occurrences: readonly Occurrence[]
  /** The most recent prompt, which is the one worth showing a person. */
  readonly exemplar: string
}

export interface GroupOptions extends MatchOptions {
  /** Occurrences needed before a repetition exists at all. Default 3. */
  readonly minOccurrences?: number
  /** Only occurrences within this many millis of `now` count. Default 14 days. */
  readonly windowMs?: number
  readonly now?: number
}

const WINDOW_DEFAULT = 14 * 24 * 60 * 60 * 1000

/**
 * PURE. Groups past prompts into repetitions.
 *
 * Single-link clustering against the group's exemplar rather than against any member, so a chain
 * of individually-similar prompts cannot drift into one group whose ends have nothing in common.
 */
export const groupRepetitions = (occurrences: readonly Occurrence[], options?: GroupOptions): Repetition[] => {
  const minOccurrences = options?.minOccurrences ?? 3
  const windowMs = options?.windowMs ?? WINDOW_DEFAULT
  const now = options?.now ?? Number.POSITIVE_INFINITY
  const cutoff = now === Number.POSITIVE_INFINITY ? Number.NEGATIVE_INFINITY : now - windowMs

  const eligible = occurrences
    .filter((occurrence) => occurrence.at >= cutoff && signature(occurrence.prompt).content.size > 0)
    .slice()
    .sort((a, b) => a.at - b.at)

  const groups: { anchor: string; members: Occurrence[] }[] = []
  for (const occurrence of eligible) {
    const group = groups.find((candidate) => isSubstantiallySame(candidate.anchor, occurrence.prompt, options))
    if (group) group.members.push(occurrence)
    else groups.push({ anchor: occurrence.prompt, members: [occurrence] })
  }

  return groups
    .filter((group) => group.members.length >= minOccurrences)
    .map((group) => ({
      key: repetitionKey(group.anchor, group.members.map((member) => member.prompt)),
      occurrences: group.members,
      exemplar: group.members[group.members.length - 1]!.prompt,
    }))
}

/**
 * PURE. The identity of a repetition: its head plus the content words every member shares, sorted.
 *
 * Built from the INTERSECTION, not from one prompt, so the key does not move when the next
 * occurrence is worded differently — which is what a remembered decline depends on.
 */
export const repetitionKey = (anchor: string, prompts: readonly string[]): string => {
  const base = signature(anchor)
  let common = new Set(base.content)
  for (const prompt of prompts) {
    const other = signature(prompt).content
    common = new Set([...common].filter((token) => other.has(token)))
  }
  const rest = [...common].filter((token) => token !== base.head).sort()
  return [base.head, ...rest].filter((token) => token.length > 0).join("-")
}

export * as RoutineSimilarity from "./similarity"
