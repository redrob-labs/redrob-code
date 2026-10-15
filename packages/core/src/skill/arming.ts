export * as SkillArming from "./arming"

import type { Skill } from "@redrob-code/schema/skill"

/**
 * K-2: the arming decision, as a pure function.
 *
 * Given the loaded skills, the current prompt text and the current tab URL, `arm` returns
 * which skills auto-arm. It reads nothing, caches nothing and logs nothing, so the decision
 * is testable on its own and identical wherever it is asked: the session prompt builder, a
 * UI preview, or a test.
 *
 * Two rules, both case-insensitive:
 *
 * - keyword: a keyword matches when it appears in the prompt on word boundaries, so `ai`
 *   does not match `said` but `docs.google.com` still matches when followed by a slash.
 * - url: a glob matches the current tab URL in full. `*` and `?` stop at `/`; `**` crosses
 *   path segments. The scheme is ignored on both sides, so a glob is written
 *   `docs.google.com/document/**` rather than `https://docs.google.com/document/**`.
 *
 * A skill with no `autoInject` block NEVER auto-arms. It stays explicitly loadable, which
 * is the point: a skill that arms on everything is a skill that is always in the prompt.
 */

/** The shape `arm` needs from a skill. Narrower than `Skill.Info` so callers can test it directly. */
export type Armable = {
  readonly name: string
  readonly autoInject?: Skill.AutoInject | undefined
}

/** One skill that armed, with the patterns that armed it. */
export type Armed = {
  readonly name: string
  /** Keywords from the skill's block that matched the prompt. */
  readonly keywords: ReadonlyArray<string>
  /** URL globs from the skill's block that matched the current tab URL. */
  readonly urls: ReadonlyArray<string>
}

export type Input = {
  readonly skills: ReadonlyArray<Armable>
  /** The current prompt text. An empty prompt matches no keyword. */
  readonly prompt: string
  /** The current tab URL, when the session is attached to one. Absent matches no glob. */
  readonly url?: string | undefined
}

const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && /[\p{L}\p{N}_]/u.test(character)

/**
 * Case-insensitive word-boundary containment. A boundary is required only where the
 * keyword's own edge is a word character, so a keyword like `.pdf` or `docs.google.com`
 * matches in running text while `ai` does not match inside `said`.
 */
const matchesKeyword = (prompt: string, keyword: string): boolean => {
  const needle = keyword.trim().toLowerCase()
  if (needle.length === 0) return false
  const haystack = prompt.toLowerCase()
  const checkStart = isWordCharacter(needle[0])
  const checkEnd = isWordCharacter(needle[needle.length - 1])
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return false
    const before = at === 0 ? undefined : haystack[at - 1]
    const after = haystack[at + needle.length]
    if ((!checkStart || !isWordCharacter(before)) && (!checkEnd || !isWordCharacter(after))) return true
    from = at + 1
  }
}

/** Drops a `scheme://` prefix and a trailing slash, so globs are written without a scheme. */
const normalizeUrl = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/\/+$/, "")

/**
 * Compiles a glob to an anchored regular expression. `**` crosses `/`; `*` and `?` do not.
 * Every other character is matched literally, so a `.` in a hostname is a dot and not a
 * wildcard - the common authoring mistake if globs were treated as regular expressions.
 */
const globToRegExp = (glob: string): RegExp => {
  let pattern = ""
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!
    if (character === "*") {
      if (glob[index + 1] === "*") {
        pattern += ".*"
        index += 1
        continue
      }
      pattern += "[^/]*"
      continue
    }
    if (character === "?") {
      pattern += "[^/]"
      continue
    }
    pattern += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${pattern}$`)
}

const matchesUrlGlob = (url: string, glob: string): boolean => {
  const normalized = normalizeUrl(glob)
  if (normalized.length === 0) return false
  return globToRegExp(normalized).test(normalizeUrl(url))
}

/** Returns the skills that auto-arm, in the order they were given. */
export const arm = (input: Input): ReadonlyArray<Armed> => {
  const armed: Array<Armed> = []
  for (const skill of input.skills) {
    const block = skill.autoInject
    // No block means never auto-arm. This is the explicit-only case, not a default-on one.
    if (block === undefined) continue
    const keywords = (block.keywords ?? []).filter((keyword) => matchesKeyword(input.prompt, keyword))
    const urls =
      input.url === undefined ? [] : (block.url ?? []).filter((glob) => matchesUrlGlob(input.url as string, glob))
    if (keywords.length === 0 && urls.length === 0) continue
    armed.push({ name: skill.name, keywords, urls })
  }
  return armed
}

/** Just the names that armed, for callers that only need the set. */
export const armedNames = (input: Input): ReadonlyArray<string> => arm(input).map((entry) => entry.name)
