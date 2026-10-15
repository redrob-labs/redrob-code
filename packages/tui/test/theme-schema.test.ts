import { expect, test } from "bun:test"
import { THEME_SCHEMA_URL } from "@redrob-code/core/links"
import { DEFAULT_THEMES } from "../src/theme"
import { HEX_COLOR_PATTERN, THEME_OPTIONAL_COLORS, THEME_REQUIRED_COLORS, themeJsonSchema } from "../src/theme/schema"

// The theme format has no runtime validator, so the hand-written schema is checked against the one
// corpus that is known-good: every bundled theme. A theme the schema would reject is a schema bug.

const schema = themeJsonSchema(THEME_SCHEMA_URL)
const hex = new RegExp(HEX_COLOR_PATTERN)
const themeProps = (schema.properties as any).theme as { properties: Record<string, unknown>; required: string[] }

test("schema is stamped with the Console URL every theme file points at", () => {
  expect(schema.$id).toBe(THEME_SCHEMA_URL)
  for (const [name, theme] of Object.entries(DEFAULT_THEMES)) {
    expect(theme.$schema, name).toBe(THEME_SCHEMA_URL)
  }
})

test("every bundled theme fits the schema's key set", () => {
  const allowed = new Set(Object.keys(themeProps.properties))
  for (const [name, theme] of Object.entries(DEFAULT_THEMES)) {
    const keys = Object.keys(theme.theme)
    const unknown = keys.filter((key) => !allowed.has(key))
    expect(unknown, `${name} has keys the schema does not know`).toEqual([])
    const missing = themeProps.required.filter((key) => !keys.includes(key))
    expect(missing, `${name} lacks keys the schema requires`).toEqual([])
  }
  expect(themeProps.required).toEqual([...THEME_REQUIRED_COLORS])
  for (const key of THEME_OPTIONAL_COLORS) expect(themeProps.required).not.toContain(key)
})

test("every colour value in the bundled themes is a hex, a resolvable ref, an ANSI index or a variant", () => {
  for (const [name, theme] of Object.entries(DEFAULT_THEMES)) {
    const defs = theme.defs ?? {}
    const roles = new Set(Object.keys(theme.theme))
    const checkScalar = (value: unknown, where: string) => {
      if (typeof value === "number") {
        expect(Number.isInteger(value) && value >= 0 && value <= 255, where).toBe(true)
        return
      }
      expect(typeof value, where).toBe("string")
      const text = value as string
      if (text.startsWith("#")) {
        expect(text, where).toMatch(hex)
        return
      }
      const resolvable = text === "transparent" || text === "none" || text in defs || roles.has(text)
      expect(resolvable, `${where}: "${text}" is not a def, a role, transparent or none`).toBe(true)
    }
    for (const [key, value] of Object.entries(defs)) checkScalar(value, `${name}.defs.${key}`)
    for (const [key, value] of Object.entries(theme.theme)) {
      if (key === "thinkingOpacity") {
        expect(typeof value, `${name}.theme.thinkingOpacity`).toBe("number")
        continue
      }
      if (typeof value === "object" && value !== null) {
        const variant = value as Record<string, unknown>
        expect(Object.keys(variant).sort(), `${name}.theme.${key}`).toEqual(["dark", "light"])
        checkScalar(variant.dark, `${name}.theme.${key}.dark`)
        checkScalar(variant.light, `${name}.theme.${key}.light`)
        continue
      }
      checkScalar(value, `${name}.theme.${key}`)
    }
  }
})
