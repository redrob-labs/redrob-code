/**
 * The default theme, tested against the brand rather than against a description of it.
 *
 * `assets/redrob.json` cannot import TypeScript, so its `defs` are a hand copy of the primitives in
 * `@redrob-code/core/theme/brand`. Three things are worth failing a build over, and none of them is
 * caught by a typecheck:
 *
 *   1. The copy is exact. A transcription slip is invisible: the TUI still paints, in the wrong blue.
 *   2. The layering holds. A role points at a named brand step, never at a loose hex, so the theme
 *      can be re-pointed at once. The derived steps the brand scale does not contain are computed
 *      here from the primitives rather than trusted.
 *   3. The pairs the interface actually paints together clear their contrast minimum, in both modes.
 *      This is the one that regresses silently: re-point one role and a dozen screens lose their
 *      legibility at once.
 *
 * The full role-to-step table, which is the specification `redrob.json` implements:
 *
 *   role                      dark            light        console token it comes from
 *   ────────────────────────  ──────────────  ───────────  ──────────────────────────────────────
 *   background                Gray 9          Gray 1       --background
 *   backgroundPanel           Gray 8/9 mix    White        --card
 *   backgroundElement         Gray 8          Gray 2       --accent-active
 *   text                      Gray 1          Gray 9       --foreground
 *   textMuted                 Gray 5          Gray 7       --muted-foreground
 *   primary                   Blue 4          Blue 6       --primary-ink
 *   secondary                 Teal 3          Teal 5       --spectrum-teal
 *   accent                    Violet 2        Violet 4     --code-keyword
 *   info                      Sky 2           Sky 4        --code-property
 *   success                   Green 3         Green 5      --success-ink
 *   warning                   Orange 3        Orange 4     --warning-ink
 *   error                     Red 3           Red 4        --destructive-ink
 *   borderSubtle              Gray 7          Gray 4       --border-strong
 *   border                    Gray 6          Gray 6       --input
 *   borderActive              Blue 5          Blue 6       --ring
 *   syntax*                   see below                    --code-*
 *   diff*Bg                   Green/Red 5     Green/Red 1  --success-soft / --destructive-soft
 *
 * Five departures, all at the semantic level, no primitive adjusted:
 *
 *   - `primary` takes the console's *ink* step rather than its fill step, because the TUI has one
 *     brand role where the console has two: Blue 5 is 3.78:1 on Gray 8, which this theme uses as a
 *     surface for text. `borderActive` keeps Blue 5, the console's ring, because 3:1 is its bar.
 *   - `border` takes `--input`, Gray 6, the one step the console holds to the same value in both
 *     themes, rather than `--border`. A terminal draws a border out of box-drawing glyphs on the
 *     background with no fill or shadow beside it, so Gray 8 on Gray 9 - 1.5:1, and legible on the
 *     console only because a card carries an elevation - would be an invisible border here.
 *   - `error` stays Red 3 on dark at 4.31:1 against `backgroundElement`, just under 4.5:1, where the
 *     console's dark rule for a colour that fails on Gray 8 is to step to level 2. Red 2 is also a
 *     destructive *fill*: `dialog-session-list` and `dialog-move-session` paint the delete-confirm
 *     row in `error` and set `text` on top of it, and Gray 1 on Red 2 is 1.2:1. One role cannot be
 *     both, so it keeps the step that works as a fill and is documented here as short on one surface.
 *   - Light `diffHighlightAdded` shares Green 5 with `diffAdded`, because the only step between them
 *     is Green 4 at 4.27:1 on Green 1. Added and removed are told apart by hue, not by that step.
 *   - `syntaxOperator` and `syntaxPunctuation` take `text` where the console mutes both to the
 *     comment step. The console's syntax colours are drawn for a snippet inside prose, where quieting
 *     the scaffolding helps the sentence around it; here code and diffs are the content, and a `;` or
 *     a `=>` at the comment's weight reads as commented out. The relationship the console draws is
 *     kept - operator and punctuation are one value - and only the step moves. Comments stay the one
 *     muted thing, which is both the console's choice and the convention everywhere else.
 */
import { expect, test } from "bun:test"
import { Brand } from "@redrob-code/core/theme/brand"
import type { RGBA } from "@opentui/core"
import { DEFAULT_THEMES, resolveTheme } from "../src/theme"

const redrob = DEFAULT_THEMES.redrob
const defs = redrob.defs ?? {}
const dark = resolveTheme(redrob, "dark")
const light = resolveTheme(redrob, "light")

/** Every step the theme names, and the primitive it must equal. Derived steps are recomputed. */
const EXPECTED_DEFS: Record<string, string> = {
  blue4: Brand.blue4,
  blue5: Brand.blue5,
  blue6: Brand.blue6,
  gray1: Brand.gray1,
  gray2: Brand.gray2,
  gray4: Brand.gray4,
  gray5: Brand.gray5,
  gray6: Brand.gray6,
  gray7: Brand.gray7,
  gray8: Brand.gray8,
  gray9: Brand.gray9,
  white: Brand.white,
  teal3: Brand.teal3,
  teal5: Brand.teal5,
  sky2: Brand.sky2,
  sky4: Brand.sky4,
  violet2: Brand.violet2,
  violet4: Brand.violet4,
  pink2: Brand.pink2,
  pink4: Brand.pink4,
  red1: Brand.red1,
  red2: Brand.red2,
  red3: Brand.red3,
  red4: Brand.red4,
  red5: Brand.red5,
  orange3: Brand.orange3,
  orange4: Brand.orange4,
  yellow3: Brand.yellow3,
  yellow5: Brand.yellow5,
  green1: Brand.green1,
  green2: Brand.green2,
  green3: Brand.green3,
  green5: Brand.green5,
  // The steps the brand scale does not contain, recomputed rather than trusted. Each is the sRGB
  // resolution of the `color-mix` the console writes for the same role.
  panelDark: Brand.mix(Brand.gray8, Brand.gray9, 0.45),
  gutterAddedDark: Brand.mix(Brand.green5, Brand.black, 0.65),
  gutterRemovedDark: Brand.mix(Brand.red5, Brand.black, 0.65),
  gutterAddedLight: Brand.mix(Brand.green2, Brand.green1, 0.5),
  gutterRemovedLight: Brand.mix(Brand.red2, Brand.red1, 0.5),
}

test("the default theme names the brand primitives exactly", () => {
  expect(defs).toEqual(EXPECTED_DEFS)
})

test("the default theme paints only through named steps", () => {
  const loose = Object.entries(redrob.theme).flatMap(([role, value]) => {
    if (typeof value !== "object" || value === null) return [`${role}: not a light/dark variant`]
    return Object.entries(value).flatMap(([mode, step]) =>
      typeof step === "string" && step in defs ? [] : [`${role}.${mode}: ${String(step)}`],
    )
  })
  expect(loose).toEqual([])
})

test("the default theme carries no leftover palette", () => {
  // The theme this replaces was an inherited OpenCode palette: an orange primary on dark, a 12-step
  // neutral ramp of pure grays, and diff colours pasted in from tokyonight. None of it is the brand's.
  const abandoned = ["#fab283", "#0a0a0a", "#eeeeee", "#3b7dd8", "#4fd6be", "#c53b53", "#828bb8", "#9d7cd8"]
  expect(abandoned.filter((hex) => JSON.stringify(redrob).includes(hex))).toEqual([])
})

test("the default theme is the brand's blue, not a near miss", () => {
  expect(hex(light.borderActive)).toBe(Brand.blue)
  expect(hex(light.primary)).toBe(Brand.blue6)
  expect(hex(dark.primary)).toBe(Brand.blue4)
  expect(hex(dark.borderActive)).toBe(Brand.blue5)
})

/* ── contrast ──────────────────────────────────────────────────────────────────────────────────── */

const SURFACES = ["background", "backgroundPanel", "backgroundElement"] as const

/** Roles the TUI draws as text on any of the three surfaces. WCAG 1.4.3, small text, 4.5:1. */
const TEXT_ROLES = [
  "text",
  "textMuted",
  "primary",
  "secondary",
  "accent",
  "info",
  "success",
  "warning",
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
] as const

for (const [mode, theme] of [
  ["dark", dark],
  ["light", light],
] as const) {
  test(`${mode} text roles clear 4.5:1 on every surface they are drawn on`, () => {
    const short = TEXT_ROLES.flatMap((role) =>
      SURFACES.map((surface) => ({ role, surface, ratio: ratio(theme[role], theme[surface]) })).filter(
        (pair) => pair.ratio < 4.5,
      ),
    )
    expect(short).toEqual([])
  })

  test(`${mode} error clears 4.5:1 on the page and the panel`, () => {
    // The one documented shortfall: `error` is also a destructive fill, so it keeps the step that
    // works under `text` and reads at 4.31:1 on `backgroundElement`. Held to the two surfaces where
    // a message is actually written, and pinned so the shortfall cannot quietly widen.
    expect(ratio(theme.error, theme.background)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(theme.error, theme.backgroundPanel)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(theme.error, theme.backgroundElement)).toBeGreaterThan(4.2)
  })

  test(`${mode} boundaries clear 3:1 against the page and the panel`, () => {
    // WCAG 1.4.11: the visual boundary of a component, and the focus indicator that replaces it.
    for (const role of ["border", "borderActive"] as const) {
      expect(ratio(theme[role], theme.background)).toBeGreaterThanOrEqual(3)
      expect(ratio(theme[role], theme.backgroundPanel)).toBeGreaterThanOrEqual(3)
    }
    // `borderSubtle` is the decorative step and is deliberately under the bar, so nothing essential
    // may be drawn in it. Asserted from the other side: it must stay quieter than `border`.
    expect(ratio(theme.borderSubtle, theme.background)).toBeLessThan(ratio(theme.border, theme.background))
  })

  test(`${mode} diff ink clears 4.5:1 on its own strip and gutter`, () => {
    const pairs = [
      ["diffAdded", "diffAddedBg"],
      ["diffAdded", "diffAddedLineNumberBg"],
      ["diffHighlightAdded", "diffAddedBg"],
      ["diffRemoved", "diffRemovedBg"],
      ["diffRemoved", "diffRemovedLineNumberBg"],
      ["diffHighlightRemoved", "diffRemovedBg"],
      ["diffLineNumber", "diffAddedLineNumberBg"],
      ["diffLineNumber", "diffRemovedLineNumberBg"],
      ["diffContext", "diffContextBg"],
      ["text", "diffAddedBg"],
      ["text", "diffRemovedBg"],
    ] as const
    const short = pairs
      .map(([ink, surface]) => ({ ink, surface, ratio: ratio(theme[ink], theme[surface]) }))
      .filter((pair) => pair.ratio < 4.5)
    expect(short).toEqual([])
  })

  test(`${mode} a selected row's ink reads on the brand fill`, () => {
    // `selectedListItemText` is left unset, so `selectedForeground` falls back to `background`, which
    // is the ink the TUI puts on a row filled with `primary`.
    expect(ratio(theme.background, theme.primary)).toBeGreaterThanOrEqual(4.5)
  })

  test(`${mode} added and removed are told apart by hue`, () => {
    expect(hex(theme.diffAdded)).not.toBe(hex(theme.diffRemoved))
    expect(hex(theme.diffAddedBg)).not.toBe(hex(theme.diffRemovedBg))
  })
}

test("code scaffolding is not drawn at the comment's weight", () => {
  // The departure above, asserted from the other side: whatever step operators and punctuation take,
  // they must read as code rather than as commented out.
  for (const theme of [dark, light]) {
    expect(hex(theme.syntaxOperator)).toBe(hex(theme.text))
    expect(hex(theme.syntaxPunctuation)).toBe(hex(theme.syntaxOperator))
    expect(hex(theme.syntaxComment)).not.toBe(hex(theme.syntaxPunctuation))
  }
})

test("the light and dark modes are genuinely different palettes", () => {
  const shared = TEXT_ROLES.filter((role) => hex(dark[role]) === hex(light[role]))
  expect(shared).toEqual([])
})

function hex(color: RGBA) {
  return `#${[color.r, color.g, color.b]
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`
}

function ratio(one: RGBA, two: RGBA) {
  return Brand.contrast(hex(one), hex(two))
}
