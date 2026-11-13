import { describe, expect, test } from "bun:test"
import { browserLabel, toolDisplayMetadata, webSearchProviderLabel } from "../../src/util/tool-display"
import { createTranslator } from "../../src/i18n"

describe("webSearchProviderLabel", () => {
  test("labels known providers", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Parallel Web Search")
    expect(webSearchProviderLabel("exa")).toBe("Exa Web Search")
  })

  for (const [name, provider] of [
    ["undefined", undefined],
    ["null", null],
    ["an object", {}],
    ["an array", []],
    ["a number", 1],
    ["an unexpected string", "other"],
  ] as const) {
    test(`uses the generic label for ${name}`, () => {
      expect(webSearchProviderLabel(provider)).toBe("Web Search")
    })
  }
})

describe("toolDisplayMetadata", () => {
  test("returns structured metadata for non-pending states", () => {
    const structured = { provider: "parallel", numResults: 3 }

    expect(toolDisplayMetadata({ status: "running", structured })).toBe(structured)
    expect(toolDisplayMetadata({ status: "completed", structured })).toBe(structured)
    expect(toolDisplayMetadata({ status: "error", structured })).toBe(structured)
  })

  test("does not expose pending or malformed metadata", () => {
    expect(toolDisplayMetadata({ status: "pending", structured: { provider: "exa" } })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed" })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", structured: null })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", structured: [] })).toEqual({})
    expect(toolDisplayMetadata(undefined)).toEqual({})
  })
})

describe("browserLabel", () => {
  const en = createTranslator("en").t
  const ko = createTranslator("ko").t

  test("names the person's Chrome in English and Korean", () => {
    const input = { action: "open", url: "https://example.com" }
    const metadata = { browser: "chrome", url: "https://example.com/" }
    expect(browserLabel(en, input, metadata)).toBe("Browser open https://example.com (in your Chrome)")
    expect(browserLabel(ko, input, metadata)).toBe("브라우저 열기 https://example.com (내 크롬에서)")
  })

  test("names the built-in browser, with the page from metadata when the input has none", () => {
    const metadata = { browser: "own", url: "https://example.com/" }
    expect(browserLabel(en, { action: "read" }, metadata)).toBe("Browser read https://example.com/ (in the built-in browser)")
    expect(browserLabel(ko, { action: "read" }, metadata)).toBe("브라우저 읽기 https://example.com/ (내장 브라우저에서)")
  })

  test("leaves the browser out until the engine says which one ran it", () => {
    expect(browserLabel(ko, { action: "click", ref: "e5" }, {})).toBe("브라우저 클릭 e5")
    expect(browserLabel(en, { action: "scroll" }, {})).toBe("Browser scroll")
  })

  test("every action has a Korean word", () => {
    for (const action of ["open", "read", "click", "type", "scroll", "wait", "screenshot"]) {
      expect(browserLabel(ko, { action }, {})).toMatch(/^브라우저 [\uAC00-\uD7A3]+$/)
    }
  })
})
