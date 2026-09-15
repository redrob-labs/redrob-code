import { dict as en, type TuiI18nKey } from "./en"
import { dict as ko } from "./ko"

export type { TuiI18nKey }
export type TuiLocale = "en" | "ko"
// `undefined` is allowed and renders as an empty string, matching the interpolation
// the hardcoded template literals used to do.
export type TuiI18nParams = Record<string, string | number | boolean | undefined>

// The TUI ships exactly two locales. English is the complete base; Korean is keyed
// against it, so a missing Korean value falls back to English rather than a raw key.
export const LOCALES = ["en", "ko"] as const
export const LOCALE_LABELS: Record<TuiLocale, string> = { en: "English", ko: "한국어" }
export const LOCALE_TAGS: Record<TuiLocale, string> = { en: "en-US", ko: "ko-KR" }
const DICTS: Record<TuiLocale, Partial<Record<TuiI18nKey, string>>> = { en, ko }

// Count-sensitive base keys. Each one has `.one` and `.other` values in every dict;
// locales with a single form (Korean) simply repeat the same phrase.
export const PLURAL_KEYS = [
  "footer.permissions",
  "status.mcp.count",
  "status.lsp.count",
  "status.formatter.count",
  "status.plugin.count",
  "sidebar.mcp.summary_errors",
  "session.patch.lines_removed",
  "session.subagent.toolcalls",
  "session.tool.questions_asked",
  "diff.files",
  "session.revert.messages",
] as const
export type TuiI18nPluralKey = (typeof PLURAL_KEYS)[number]

// Commands and key bindings carry an English grouping identifier because it is part of
// the plugin API surface. The palette and the which-key panel translate it on render,
// and a plugin-provided group nobody knows about passes through verbatim.
export const CATEGORY_KEYS: Record<string, TuiI18nKey> = {
  System: "palette.category.system",
  Session: "palette.category.session",
  Agent: "palette.category.agent",
  Workspace: "palette.category.workspace",
  Provider: "palette.category.provider",
  Dialog: "palette.category.dialog",
  Prompt: "palette.category.prompt",
  Permission: "palette.category.permission",
  Question: "palette.category.question",
  VCS: "palette.category.vcs",
  Plugins: "palette.category.plugins",
  Autocomplete: "palette.category.autocomplete",
  Internal: "palette.category.internal",
  External: "palette.category.external",
  Skills: "skill.category",
}

export function isLocale(value: unknown): value is TuiLocale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value)
}

// Accepts anything a user or a config file might hold: "ko", "KO", "ko-KR", "ko_KR.UTF-8".
export function normalizeLocale(value: unknown): TuiLocale {
  return languageOf(value) ?? "en"
}

// POSIX candidates, most specific first (LC_ALL, LC_MESSAGES, LANG). "C" and "POSIX"
// carry no language, so they fall through to the next candidate and finally English.
export function detectLocale(candidates: readonly (string | undefined | null)[]): TuiLocale {
  return (
    candidates.reduce<TuiLocale | undefined>((found, candidate) => found ?? languageOf(candidate), undefined) ?? "en"
  )
}

// A persisted choice always wins; otherwise fall back to the environment.
export function resolveLocale(stored: unknown, candidates: readonly (string | undefined | null)[] = []): TuiLocale {
  return isLocale(stored) ? stored : detectLocale(candidates)
}

// Persisted in the shared TUI KV store, so the choice survives future TUI launches.
export const LANGUAGE_KV_KEY = "language"

// Code that runs outside the render tree — plugin bootstrap, event handlers, command
// registration — reads the persisted locale straight from the KV store. The read stays
// reactive because the KV store is a Solid store, so a getter that calls this re-resolves
// when the language changes.
export function kvTranslator(kv: { get: <Value = unknown>(key: string, fallback?: Value) => Value }) {
  return createTranslator(
    resolveLocale(kv.get(LANGUAGE_KV_KEY), [
      process.env.LC_ALL,
      process.env.LC_MESSAGES,
      process.env.LANG,
      process.env.LANGUAGE,
    ]),
  )
}

// Splits an unresolved message around a single placeholder so the caller can render that
// value with its own styling while word order still comes from the dictionary. Pass the
// result of `t(key)` without params, which leaves the placeholder literal.
export function splitTemplate(text: string, name: string) {
  const marker = `{{${name}}}`
  const index = text.indexOf(marker)
  if (index === -1) return [text, ""] as const
  return [text.slice(0, index), text.slice(index + marker.length)] as const
}

export function resolveTemplate(text: string, params?: TuiI18nParams) {
  if (!params) return text
  return text.replace(/{{\s*([^}]+?)\s*}}/g, (_, rawKey) => {
    const value = params[String(rawKey)]
    return value === undefined ? "" : String(value)
  })
}

export function createTranslator(locale: TuiLocale) {
  const dict = DICTS[locale] as Record<string, string | undefined>
  const base = en as Record<string, string | undefined>

  const lookup = (key: string) => dict[key] ?? base[key] ?? key

  const t = (key: TuiI18nKey, params?: TuiI18nParams) => resolveTemplate(lookup(key), params)

  const plural = (key: TuiI18nPluralKey, count: number, params?: TuiI18nParams) => {
    const form = pluralCategory(LOCALE_TAGS[locale], count)
    const candidate = `${key}.${form}`
    const text = dict[candidate] ?? base[candidate] ?? lookup(`${key}.other`)
    return resolveTemplate(text, { ...params, count })
  }

  const category = (value: unknown) => {
    if (typeof value !== "string" || !value) return undefined
    const key = CATEGORY_KEYS[value]
    return key ? t(key) : value
  }

  return { locale, t, plural, category }
}

export type TuiTranslator = ReturnType<typeof createTranslator>

const rules = new Map<string, Intl.PluralRules>()

function pluralCategory(tag: string, count: number) {
  const cached = rules.get(tag)
  if (cached) return cached.select(count)
  const next = new Intl.PluralRules(tag)
  rules.set(tag, next)
  return next.select(count)
}

function languageOf(value: unknown): TuiLocale | undefined {
  if (typeof value !== "string") return
  // Strip POSIX codeset/modifier suffixes and separate the language subtag.
  const language = value.trim().split(/[.@:]/, 1)[0]?.replace(/_/g, "-").split("-", 1)[0]?.toLowerCase()
  return isLocale(language) ? language : undefined
}
