import { describe, expect, test } from "bun:test"
import { Glob } from "bun"

// Guard against user-facing English creeping back into the TUI outside the dictionaries.
//
// It only looks at two positions the TUI actually renders — the value of a user-facing
// prop and a JSX text child — and it only reports a literal that reads as English prose,
// meaning two consecutive ASCII words. That threshold is deliberately narrow: it never
// fires on identifiers, file paths, single-word key legends, acronyms, slash commands or
// proper nouns, so the guard stays useful without an ever-growing exception list.
const PROSE = /[A-Za-z]{2,}[ ][A-Za-z]{2,}/
const USER_FACING_PROPS = ["title", "desc", "description", "message", "placeholder", "busyText", "label", "action"]

const root = new URL("../../src/", import.meta.url)

// The dictionaries are the English source copy, so prose is the point.
const DICTIONARIES = ["i18n/en.ts", "i18n/ko.ts"]

// `description` in these files is an Effect Schema annotation. It becomes the config JSON
// schema that editors show while someone edits redrob.json or tui.json, not TUI output.
const CONFIG_SCHEMA_FILES = ["config/index.tsx", "config/keybind.ts"]

// Text sent to the model or written to stderr before the TUI renders. Translating it would
// change what the model reads or what a piped CLI run prints.
const NON_UI_LITERALS = [
  "plugins.install is only available in plugin context",
  "slots.register is only available in plugin context",
  "theme.install is only available in plugin context",
  "Plugin runtime is not available.",
]

// Return values in these modules are raw external errors or proper tool names, not
// copy rendered by a TUI component.
const NON_UI_RETURN_FILES = ["util/error.ts", "util/tool-display.ts"]
const NON_UI_RETURN_PREFIXES = ["Note: The user selected", "<system-reminder>"]

type Finding = { file: string; line: number; position: string; value: string }

async function sources() {
  const found: { path: string; text: string }[] = []
  for await (const path of new Glob("**/*.{ts,tsx}").scan(Bun.fileURLToPath(root))) {
    found.push({ path, text: await Bun.file(new URL(path, root)).text() })
  }
  return found.toSorted((a, b) => a.path.localeCompare(b.path))
}

function lineOf(text: string, index: number) {
  return text.slice(0, index).split("\n").length
}

function propFindings(file: string, text: string): Finding[] {
  const pattern = new RegExp(String.raw`\b(${USER_FACING_PROPS.join("|")})\s*[:=]\s*\{?\s*(["'\`])([^"'\`\n]*)\2`, "g")
  return [...text.matchAll(pattern)].flatMap((match) => {
    const position = match[1]!
    const value = match[3]!.trim()
    if (!PROSE.test(value)) return []
    if (position === "description" && CONFIG_SCHEMA_FILES.includes(file)) return []
    if (NON_UI_LITERALS.includes(value)) return []
    return [{ file, line: lineOf(text, match.index), position, value }]
  })
}

// JSX text children. Punctuation that only appears in code — parentheses, braces, `=`,
// `;`, `:` — disqualifies a candidate so TypeScript generics such as `new Set<string>()`
// are not mistaken for copy. Prose that genuinely needs those characters still gets caught
// from the other side, as the value of a user-facing prop.
function textFindings(file: string, text: string): Finding[] {
  return [...text.matchAll(/>([^<>{}()=;:\n]*[A-Za-z][^<>{}()=;:\n]*)</g)].flatMap((match) => {
    const value = match[1]!.trim()
    if (!PROSE.test(value)) return []
    return [{ file, line: lineOf(text, match.index), position: "jsx", value }]
  })
}

// Visible derived copy often lives in a memo before being passed to a JSX prop.
// Scanning returned literals catches that seam, including prompt placeholders.
function returnFindings(file: string, text: string): Finding[] {
  if (NON_UI_RETURN_FILES.includes(file)) return []
  return [/\breturn\s+`([^`\n]*)`/g, /\breturn\s+"([^"\n]*)"/g, /\breturn\s+'([^'\n]*)'/g].flatMap((pattern) =>
    [...text.matchAll(pattern)].flatMap((match) => {
      const value = match[1]!.trim()
      if (!PROSE.test(value)) return []
      if (NON_UI_RETURN_PREFIXES.some((prefix) => value.startsWith(prefix))) return []
      return [{ file, line: lineOf(text, match.index), position: "return", value }]
    }),
  )
}

describe("hardcoded user-facing English", () => {
  test("every rendered label and prose string goes through the dictionaries", async () => {
    const findings = (await sources())
      .filter((source) => !DICTIONARIES.includes(source.path))
      .flatMap((source) => [
        ...propFindings(source.path, source.text),
        ...textFindings(source.path, source.text),
        ...returnFindings(source.path, source.text),
      ])
      .map((finding) => `${finding.file}:${finding.line} [${finding.position}] ${finding.value}`)

    expect(findings).toEqual([])
  })

  test("stays sensitive to prose and quiet about identifiers, paths and legends", () => {
    const flagged = (value: string) => propFindings("component/example.tsx", `title="${value}"`).length === 1
    expect(flagged("Rename Session")).toBe(true)
    expect(flagged("Do you want to move these changes with the session?")).toBe(true)

    expect(flagged("delete")).toBe(false)
    expect(flagged("/connect")).toBe(false)
    expect(flagged("MCP")).toBe(false)
    expect(flagged("packages/tui/src/app.tsx")).toBe(false)
    expect(flagged("anthropic/claude-sonnet-4")).toBe(false)
    expect(flagged("ctrl+alt+shift+k")).toBe(false)
    expect(flagged("세션 이름 변경")).toBe(false)
  })

  test("catches English prose returned from a derived placeholder", () => {
    const source = 'const placeholder = createMemo(() => { return `Ask anything... "${example}"` })'
    expect(returnFindings("component/example.tsx", source)).toEqual([
      {
        file: "component/example.tsx",
        line: 1,
        position: "return",
        value: 'Ask anything... "${example}"',
      },
    ])
  })
})
