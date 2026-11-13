import { describe, expect, test } from "bun:test"
import { Usage } from "../../src/util/usage"
import { createTranslator } from "../../src/i18n"

describe("Usage", () => {
  test("bounds start today and this month at local midnight", () => {
    const now = new Date(2026, 10, 13, 14, 28, 5)
    expect(Usage.bounds(now)).toEqual({
      day: new Date(2026, 10, 13).getTime(),
      month: new Date(2026, 10, 1).getTime(),
    })
  })

  test("format folds reasoning into output and cache reads into writes, like the footer", () => {
    const value = Usage.format({
      cost: 7.92,
      tokens: { input: 96_400, output: 1_200, reasoning: 300, cache: { read: 1_000_000, write: 500_000 } },
    })
    expect(value).toEqual({ input: "96.4K", output: "1.5K", cache: "1.5M", cost: "$7.92" })
  })

  test("the usage line reads in both languages", () => {
    const value = Usage.format({
      cost: 0,
      tokens: { input: 12, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    expect(createTranslator("en").t("status.usage.line", value)).toBe("in 12 · out 3 · cache 0 · $0.00")
    expect(createTranslator("ko").t("status.usage.line", value)).toBe("입력 12 · 출력 3 · 캐시 0 · $0.00")
  })
})
