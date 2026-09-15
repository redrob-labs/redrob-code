import { createContext, createMemo, useContext, type Accessor, type ParentProps } from "solid-js"
import { useKV } from "./kv"
import {
  createTranslator,
  isLocale,
  LANGUAGE_KV_KEY,
  LOCALE_LABELS,
  LOCALES,
  resolveLocale,
  type TuiI18nKey,
  type TuiI18nParams,
  type TuiI18nPluralKey,
  type TuiLocale,
} from "../i18n"

export { LANGUAGE_KV_KEY }

export type LanguageContext = {
  locale: Accessor<TuiLocale>
  locales: readonly TuiLocale[]
  label: (locale: TuiLocale) => string
  t: (key: TuiI18nKey, params?: TuiI18nParams) => string
  plural: (key: TuiI18nPluralKey, count: number, params?: TuiI18nParams) => string
  // Grouping identifier (a command `category` or a binding `group`) resolved for display.
  category: (value: unknown) => string | undefined
  set: (locale: TuiLocale) => void
}

// English default so `useLanguage()` also works above KVProvider, where the crash
// screen renders and no persisted preference can be read.
const english = createTranslator("en")
const fallback: LanguageContext = {
  locale: () => "en",
  locales: LOCALES,
  label: (locale) => LOCALE_LABELS[locale],
  t: english.t,
  plural: english.plural,
  category: english.category,
  set: () => {},
}

const ctx = createContext<LanguageContext>(fallback)

export function LanguageProvider(props: ParentProps<{ languages?: readonly (string | undefined)[] }>) {
  const kv = useKV()
  // Reading through the KV store keeps this reactive in both directions: the persisted
  // choice lands as soon as kv.json finishes loading, and set() re-renders through the
  // same path instead of a second source of truth.
  const locale = createMemo(() => resolveLocale(kv.get(LANGUAGE_KV_KEY), props.languages ?? []))
  const translator = createMemo(() => createTranslator(locale()))

  const value: LanguageContext = {
    locale,
    locales: LOCALES,
    label: (value) => LOCALE_LABELS[value],
    t: (key, params) => translator().t(key, params),
    plural: (key, count, params) => translator().plural(key, count, params),
    category: (value) => translator().category(value),
    set(next) {
      if (!isLocale(next)) return
      kv.set(LANGUAGE_KV_KEY, next)
    },
  }

  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useLanguage() {
  return useContext(ctx)
}
