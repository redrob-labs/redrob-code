import { describe, expect, test } from "bun:test"
import { dict as en } from "../../src/i18n/en"
import { dict as ko } from "../../src/i18n/ko"
import {
  createTranslator,
  detectLocale,
  isLocale,
  LOCALES,
  LOCALE_LABELS,
  normalizeLocale,
  PLURAL_KEYS,
  resolveLocale,
  resolveTemplate,
  type TuiI18nKey,
} from "../../src/i18n"
import { LANGUAGE_KV_KEY } from "../../src/context/language"

const params = (text: string) => [...text.matchAll(/{{\s*([^}]+?)\s*}}/g)].map((match) => match[1]).sort()

describe("en/ko parity", () => {
  test("ships exactly the two advertised locales", () => {
    expect(LOCALES).toEqual(["en", "ko"])
    expect(LOCALE_LABELS).toEqual({ en: "English", ko: "한국어" })
  })

  test("covers every English key in Korean and adds none of its own", () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort())
  })

  test("leaves no Korean value empty and keeps every interpolation parameter", () => {
    const empty = Object.entries(ko).filter(([, value]) => value.trim() === "")
    expect(empty).toEqual([])

    const mismatched = Object.entries(en).flatMap(([key, value]) => {
      const expected = params(value)
      const actual = params(ko[key as TuiI18nKey])
      return expected.join() === actual.join() ? [] : [{ key, expected, actual }]
    })
    expect(mismatched).toEqual([])
  })

  test("gives every plural base a one and other form in both locales", () => {
    const missing = PLURAL_KEYS.flatMap((base) =>
      (["one", "other"] as const).flatMap((category) =>
        [["en", en] as const, ["ko", ko] as const].flatMap(([name, dict]) =>
          dict[`${base}.${category}` as TuiI18nKey] ? [] : [`${name}:${base}.${category}`],
        ),
      ),
    )
    expect(missing).toEqual([])
  })
})

describe("detection and normalization", () => {
  test("normalizes POSIX and casing variants onto a supported locale", () => {
    expect(normalizeLocale("ko")).toBe("ko")
    expect(normalizeLocale("KO")).toBe("ko")
    expect(normalizeLocale("ko-KR")).toBe("ko")
    expect(normalizeLocale("ko_KR.UTF-8")).toBe("ko")
    expect(normalizeLocale("en_US.UTF-8@euro")).toBe("en")
    expect(normalizeLocale("ja_JP.UTF-8")).toBe("en")
    expect(normalizeLocale(undefined)).toBe("en")
    expect(normalizeLocale(7)).toBe("en")
  })

  test("takes the most specific POSIX candidate and skips language-free ones", () => {
    expect(detectLocale(["ko_KR.UTF-8", "en_US.UTF-8", "en_US.UTF-8"])).toBe("ko")
    expect(detectLocale([undefined, "ko_KR.UTF-8"])).toBe("ko")
    expect(detectLocale(["C", "POSIX", "ko_KR.UTF-8"])).toBe("ko")
    expect(detectLocale(["C", "POSIX"])).toBe("en")
    expect(detectLocale([])).toBe("en")
  })

  test("recognizes only the supported locale tags", () => {
    expect(isLocale("ko")).toBe(true)
    expect(isLocale("ko-KR")).toBe(false)
    expect(isLocale(null)).toBe(false)
  })
})

describe("fallback, interpolation and plurals", () => {
  test("falls back to the key when nothing resolves", () => {
    expect(createTranslator("ko").t("nope.not.a.key" as TuiI18nKey)).toBe("nope.not.a.key")
  })

  test("resolves Korean first, then the English base", () => {
    expect(createTranslator("ko").t("dialog.esc")).toBe(ko["dialog.esc"])
    expect(createTranslator("en").t("dialog.esc")).toBe(en["dialog.esc"])
    // The English base is the second link in the chain. Parity makes it unreachable for
    // real keys today, so the observable middle step is a plural category Korean has no
    // dedicated form for: it still resolves through `.other` rather than leaking a key.
    expect(createTranslator("ko").plural("footer.permissions", 1)).toBe(
      resolveTemplate(ko["footer.permissions.other"], { count: 1 }),
    )
  })

  test("interpolates named parameters and renders missing ones as empty", () => {
    expect(resolveTemplate("Read {{path}}", { path: "src/app.tsx" })).toBe("Read src/app.tsx")
    expect(resolveTemplate("Read {{ path }}", { path: "src/app.tsx" })).toBe("Read src/app.tsx")
    expect(resolveTemplate("Read {{path}}", { path: undefined })).toBe("Read ")
    expect(resolveTemplate("Read {{path}}", { other: "ignored" })).toBe("Read ")
    expect(resolveTemplate("no params", { path: "x" })).toBe("no params")
    expect(createTranslator("en").t("permission.title.read", { path: "src/app.tsx" })).toBe("Read src/app.tsx")
  })

  test("selects English plural categories and collapses Korean to one form", () => {
    const english = createTranslator("en")
    expect(english.plural("session.subagent.toolcalls", 1)).toBe("1 toolcall")
    expect(english.plural("session.subagent.toolcalls", 0)).toBe("0 toolcalls")
    expect(english.plural("session.subagent.toolcalls", 2)).toBe("2 toolcalls")

    const korean = createTranslator("ko")
    expect(korean.plural("session.subagent.toolcalls", 1)).toBe("도구 호출 1회")
    expect(korean.plural("session.subagent.toolcalls", 2)).toBe("도구 호출 2회")
  })

  test("passes extra parameters alongside the count", () => {
    expect(createTranslator("en").plural("sidebar.mcp.summary_errors", 2, { active: 3 })).toBe("(3 active, 2 errors)")
    expect(createTranslator("en").plural("sidebar.mcp.summary_errors", 1, { active: 3 })).toBe("(3 active, 1 error)")
  })
})

describe("persistence seam", () => {
  test("stores the choice under the language KV key", () => {
    expect(LANGUAGE_KV_KEY).toBe("language")
  })

  test("prefers the persisted locale over the environment and ignores junk", () => {
    expect(resolveLocale("ko", ["en_US.UTF-8"])).toBe("ko")
    expect(resolveLocale("en", ["ko_KR.UTF-8"])).toBe("en")
    expect(resolveLocale(undefined, ["ko_KR.UTF-8"])).toBe("ko")
    // Only the exact tags the dialog writes count as persisted; anything else falls
    // through to environment detection.
    expect(resolveLocale("ko-KR", ["en_US.UTF-8"])).toBe("en")
    expect(resolveLocale({ locale: "ko" }, ["ko_KR.UTF-8"])).toBe("ko")
    expect(resolveLocale("klingon", ["en_US.UTF-8"])).toBe("en")
  })

  test("reads and writes the locale through the KV store, not a private cache", async () => {
    const source = await Bun.file(new URL("../../src/context/language.tsx", import.meta.url)).text()
    expect(source).toContain("kv.get(LANGUAGE_KV_KEY)")
    expect(source).toContain("kv.set(LANGUAGE_KV_KEY, next)")
  })
})

describe("language command", () => {
  test("registers language.switch as /language with a lang alias", async () => {
    const source = await Bun.file(new URL("../../src/app.tsx", import.meta.url)).text()
    expect(source).toContain(`name: "language.switch"`)
    expect(source).toContain(`slashName: "language"`)
    expect(source).toContain(`slashAliases: ["lang"]`)
    expect(source).toContain("<DialogLanguageList />")
  })
})
