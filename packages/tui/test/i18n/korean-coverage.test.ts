import { describe, expect, test } from "bun:test"
import { dict as en } from "../../src/i18n/en"
import { dict as ko } from "../../src/i18n/ko"
import { CATEGORY_KEYS, createTranslator, type TuiI18nKey } from "../../src/i18n"
import { TuiKeybind } from "../../src/config/keybind"

const korean = createTranslator("ko")
const english = createTranslator("en")
const HANGUL = /[\uAC00-\uD7A3]/

// Everything a Korean value is allowed to keep verbatim: {highlight} spans and their
// contents (literal command tokens, config keys, paths), {{placeholders}}, product and
// provider names, CLI tokens and keyboard legends.
const VERBATIM = [
  /\{highlight\}.*?\{\/highlight\}/g,
  /\{\{[^}]*\}\}/g,
  /\{(?:env|file):[^}]*\}/g,
  /Redrob ?Code|RedrobCode|GitHub|Markdown|Git|Python|Go|Docker|npm|xterm|AGENTS\.md/g,
  /\b(?:MCP|LSP|TUI|API|OS|ID|AI|LLM|PR|PRs|SSE|VCS|JSON|URL)\b/g,
  /\bwhich-key\b|\bBuild\b|\bPlan\b|\bredrob\b|\bgit\b|\btab\b|\benter\b|\besc\b|\bspace\b|\breturn\b/g,
  /\/[a-z]+/g,
]

function residualEnglish(value: string) {
  return VERBATIM.reduce((text, pattern) => text.replace(pattern, " "), value).match(/[A-Za-z]{2,}[ ][A-Za-z]{2,}/g)
}

function keysUnder(prefix: string) {
  return (Object.keys(en) as TuiI18nKey[]).filter((key) => key.startsWith(prefix))
}

// Keyboard legends name physical keys, so they stay verbatim in every locale the same way
// `dialog.esc` and `help.dismiss` already do.
const LEGEND_KEYS: readonly TuiI18nKey[] = ["debug.hint.enter"]

function assertKorean(keys: readonly TuiI18nKey[]) {
  const missing = keys.filter((key) => !HANGUL.test(ko[key]) && !LEGEND_KEYS.includes(key))
  expect(missing).toEqual([])
  const leftover = keys.flatMap((key) => {
    const residual = residualEnglish(ko[key])
    return residual ? [{ key, residual }] : []
  })
  expect(leftover).toEqual([])
}

describe("keybind descriptions", () => {
  test("names a dictionary key for every binding and keeps the English config schema text", () => {
    const names = Object.keys(TuiKeybind.Definitions) as (keyof typeof TuiKeybind.Definitions)[]
    expect(names.length).toBeGreaterThan(150)

    const mismatched = names.flatMap((name) => {
      const definition = TuiKeybind.Definitions[name]
      if (definition.key !== `keybind.${name}`) return [{ name, key: definition.key }]
      // The config JSON schema keeps the English copy, sourced from the same key.
      if (definition.description !== en[definition.key]) return [{ name, key: definition.key }]
      return []
    })
    expect(mismatched).toEqual([])
  })

  test("resolves every command binding description into Korean", () => {
    const keys = Object.values(TuiKeybind.CommandDescriptionKeys)
    expect(keys.length).toBeGreaterThan(150)
    assertKorean(keys)

    // The which-key panel translates through the command name, so spot-check that seam.
    expect(TuiKeybind.CommandDescriptionKeys["session.compact"]).toBe("keybind.session_compact")
    expect(korean.t(TuiKeybind.CommandDescriptionKeys["session.compact"]!)).toBe("세션 요약")
    expect(english.t(TuiKeybind.CommandDescriptionKeys["session.compact"]!)).toBe("Compact the session")
  })

  test("covers every keybind name, with no orphan keybind keys left in the dictionary", () => {
    const listed: string[] = keysUnder("keybind.")
    expect(listed.toSorted()).toEqual(
      Object.keys(TuiKeybind.Definitions)
        .map((name) => `keybind.${name}`)
        .toSorted(),
    )
  })
})

describe("tips corpus", () => {
  test("translates every tip and keeps command tokens and config keys verbatim", () => {
    const keys = keysUnder("tip.")
    expect(keys.length).toBeGreaterThan(95)
    assertKorean(keys)
  })

  test("is fully referenced by the tips view, so no tip silently falls back", async () => {
    const source = await Bun.file(new URL("../../src/feature-plugins/home/tips-view.tsx", import.meta.url)).text()
    const orphans = keysUnder("tip.").filter((key) => !source.includes(`"${key}"`))
    expect(orphans).toEqual([])
  })

  test("renders a Korean tip with its highlighted command token intact", () => {
    expect(korean.t("tip.no_models")).toContain("{highlight}/connect{/highlight}")
    expect(korean.t("tip.command_or", { command: "/models", shortcut: "ctrl+m" })).toBe("/models 또는 ctrl+m")
    expect(english.t("tip.command_or", { command: "/models", shortcut: "ctrl+m" })).toBe("/models or ctrl+m")
  })
})

describe("previously untranslated surfaces", () => {
  const surfaces = {
    "diff viewer": "diff.",
    "which-key": "whichkey.",
    "workspace dialogs": "workspace.",
    "debug diagnostics": "debug.",
    "MCP diagnostics": "mcp.",
    "plugin manager": "plugins.",
    "dialog action legends": "action.",
  }

  for (const [name, prefix] of Object.entries(surfaces)) {
    test(`translates every ${name} string`, () => {
      const keys = keysUnder(prefix)
      expect(keys.length).toBeGreaterThan(3)
      assertKorean(keys)
    })
  }

  test("translates every grouping label the palette and which-key can show", () => {
    const keys = Object.values(CATEGORY_KEYS)
    expect(keys.length).toBeGreaterThan(10)
    assertKorean([...keys, "palette.category.unknown"])

    expect(korean.category("VCS")).toBe("버전 관리")
    expect(korean.category("Plugins")).toBe("플러그인")
    expect(english.category("VCS")).toBe("VCS")
    // A grouping identifier a plugin invented passes through rather than showing a key.
    expect(korean.category("Weather")).toBe("Weather")
    expect(korean.category(undefined)).toBeUndefined()
  })

  test("reads the debug and MCP dialog copy from the dictionary", async () => {
    const debug = await Bun.file(new URL("../../src/component/dialog-debug.tsx", import.meta.url)).text()
    for (const key of keysUnder("debug.")) expect(debug).toContain(`"${key}"`)

    const mcp = await Bun.file(new URL("../../src/component/dialog-mcp.tsx", import.meta.url)).text()
    for (const key of keysUnder("mcp.")) expect(mcp).toContain(`"${key}"`)
  })
})

describe("prompt placeholders", () => {
  test("translates interpolated normal and shell prompts without changing their examples", () => {
    expect(korean.t("prompt.placeholder.normal", { example: "TODO 하나를 해결해 줘" })).toBe(
      '무엇이든 물어보세요... "TODO 하나를 해결해 줘"',
    )
    expect(korean.t("prompt.placeholder.shell", { example: "git status" })).toBe('명령어 실행... "git status"')
    expect(english.t("prompt.placeholder.normal", { example: "Fix one TODO" })).toBe(
      'Ask anything... "Fix one TODO"',
    )
    expect(english.t("prompt.placeholder.shell", { example: "git status" })).toBe('Run a command... "git status"')
  })
})

describe("English locale", () => {
  test("keeps the English copy for every key the Korean pass touched", () => {
    const keys = [
      ...keysUnder("keybind."),
      ...keysUnder("tip."),
      ...keysUnder("diff."),
      ...keysUnder("whichkey."),
      ...keysUnder("workspace."),
      ...keysUnder("debug."),
      ...keysUnder("mcp."),
      ...keysUnder("plugins."),
      ...keysUnder("action."),
    ]
    const wrong = keys.filter((key) => english.t(key) !== en[key])
    expect(wrong).toEqual([])
    expect(keys.some((key) => HANGUL.test(en[key]))).toBe(false)
  })
})
