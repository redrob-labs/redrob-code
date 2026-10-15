import type { Theme } from "."

/**
 * JSON Schema for a TUI theme file (`{ "$schema": THEME_SCHEMA_URL, "defs": {...}, "theme": {...} }`).
 *
 * The theme format has no runtime schema -- `ThemeJson` in `./index.ts` is a plain TypeScript type and
 * `resolveTheme` is the only validator -- so this document is written by hand. The colour-key list is
 * checked against the `Theme` type: adding a colour to `Theme` without listing it here fails
 * `typecheck`, and listing one that does not exist fails too. `redrob generate --schema` writes the
 * result to `packages/redrob/schema/theme.json`, which `check:generated` keeps in step.
 */

type ThemeColor = Exclude<keyof Theme, "thinkingOpacity" | "_hasSelectedListItemText">
type OptionalColor = "selectedListItemText" | "backgroundMenu"
type RequiredColor = Exclude<ThemeColor, OptionalColor>

// `satisfies` plus the two Exact* checks below make this list exactly the set of colour keys.
export const THEME_REQUIRED_COLORS = [
  "primary",
  "secondary",
  "accent",
  "error",
  "warning",
  "success",
  "info",
  "text",
  "textMuted",
  "background",
  "backgroundPanel",
  "backgroundElement",
  "border",
  "borderActive",
  "borderSubtle",
  "diffAdded",
  "diffRemoved",
  "diffContext",
  "diffHunkHeader",
  "diffHighlightAdded",
  "diffHighlightRemoved",
  "diffAddedBg",
  "diffRemovedBg",
  "diffContextBg",
  "diffLineNumber",
  "diffAddedLineNumberBg",
  "diffRemovedLineNumberBg",
  "markdownText",
  "markdownHeading",
  "markdownLink",
  "markdownLinkText",
  "markdownCode",
  "markdownBlockQuote",
  "markdownEmph",
  "markdownStrong",
  "markdownHorizontalRule",
  "markdownListItem",
  "markdownListEnumeration",
  "markdownImage",
  "markdownImageText",
  "markdownCodeBlock",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
] as const satisfies readonly RequiredColor[]

export const THEME_OPTIONAL_COLORS = ["selectedListItemText", "backgroundMenu"] as const satisfies readonly OptionalColor[]

// Compile-time exhaustiveness: every RequiredColor / OptionalColor must appear in its list.
type MissingRequired = Exclude<RequiredColor, (typeof THEME_REQUIRED_COLORS)[number]>
type MissingOptional = Exclude<OptionalColor, (typeof THEME_OPTIONAL_COLORS)[number]>
const _exactRequired: MissingRequired extends never ? true : never = true
const _exactOptional: MissingOptional extends never ? true : never = true
void _exactRequired
void _exactOptional

export const HEX_COLOR_PATTERN = "^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$"

/**
 * Builds the schema document. `$id` is where the Console serves it; editors fetch it from a theme
 * file's `$schema` field.
 */
export function themeJsonSchema(id: string): Record<string, unknown> {
  const colorValue = { $ref: "#/$defs/ColorValue" }
  const properties: Record<string, unknown> = {}
  for (const key of THEME_REQUIRED_COLORS) properties[key] = colorValue
  for (const key of THEME_OPTIONAL_COLORS) properties[key] = colorValue
  properties.thinkingOpacity = {
    type: "number",
    minimum: 0,
    maximum: 1,
    description: "Opacity applied to thinking/reasoning text. Defaults to 0.6.",
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    title: "Redrob Code TUI theme",
    description:
      "A colour theme for the Redrob Code terminal interface. `defs` holds named colours; `theme` maps every interface role to a colour, a `defs` name, another role, or a dark/light pair.",
    type: "object",
    properties: {
      $schema: { type: "string" },
      defs: {
        type: "object",
        description: "Named colours referenced from `theme` (or from other defs).",
        additionalProperties: { $ref: "#/$defs/HexOrRef" },
      },
      theme: {
        type: "object",
        properties,
        required: [...THEME_REQUIRED_COLORS],
        additionalProperties: false,
      },
    },
    required: ["theme"],
    additionalProperties: false,
    $defs: {
      HexColor: {
        type: "string",
        pattern: HEX_COLOR_PATTERN,
        description: "Hex colour: #RGB, #RGBA, #RRGGBB or #RRGGBBAA, e.g. #8aafff",
      },
      RefName: {
        type: "string",
        description:
          "The name of an entry in `defs`, the name of another role in `theme`, or `transparent` / `none` for no colour.",
        not: { pattern: "^#" },
      },
      HexOrRef: { anyOf: [{ $ref: "#/$defs/HexColor" }, { $ref: "#/$defs/RefName" }] },
      AnsiIndex: {
        type: "integer",
        minimum: 0,
        maximum: 255,
        description: "An ANSI 256-colour palette index.",
      },
      Variant: {
        type: "object",
        description: "A colour that differs between dark and light terminals.",
        properties: {
          dark: { $ref: "#/$defs/HexOrRef" },
          light: { $ref: "#/$defs/HexOrRef" },
        },
        required: ["dark", "light"],
        additionalProperties: false,
      },
      ColorValue: {
        anyOf: [{ $ref: "#/$defs/HexOrRef" }, { $ref: "#/$defs/AnsiIndex" }, { $ref: "#/$defs/Variant" }],
      },
    },
    allowComments: true,
    allowTrailingCommas: true,
  }
}
