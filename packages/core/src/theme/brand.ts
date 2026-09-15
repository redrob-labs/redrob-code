/**
 * The Redrob brand primitives, transcribed from the token system on Redrob Console.
 *
 * Two layers, and only two, the same as the console's stylesheet:
 *
 *   1. PRIMITIVES, this file. Confirmed brand HEX values. They carry no meaning and no theme:
 *      Blue 6 is Blue 6 in light and in dark. Nothing here is adjusted to make a mapping work.
 *   2. SEMANTICS, per surface. Each surface names roles and points them at these steps, because a
 *      terminal and a browser cannot share a semantic layer: one paints with CSS custom properties
 *      against a page it controls, the other emits colours into a terminal whose palette, colour
 *      depth and background belong to the user.
 *
 * The surfaces that read this file:
 *
 *   `packages/core/src/oauth/page.ts`             browser, loopback OAuth callback pages
 *   `packages/tui/src/theme/assets/redrob.json`   terminal, the default theme (values mirrored,
 *                                                 because a JSON asset cannot import TypeScript;
 *                                                 `packages/tui/test/theme-tokens.test.ts` fails
 *                                                 the build if the two ever disagree)
 *   `packages/tui/src/component/error-component.tsx`  terminal, the crash screen's own palette
 *   `packages/redrob/src/cli/cmd/run/theme.ts`    terminal, the direct-mode seed palette
 *
 * The terminal surfaces take hex from here and nothing else. No radius, no shadow, no font: a
 * terminal has one cell grid and one font, both the user's, and pretending otherwise produces
 * output that lies about what it drew.
 */

/** Primary. `blue` is Redrob Blue and the same value as `blue6`. */
export const blue = "#2b52ff"
export const black = "#0a0b0c"
export const white = "#ffffff"

/** Blue tint, 1 lightest to 10 darkest. */
export const blue1 = "#eff4ff"
export const blue2 = "#d9e6ff"
export const blue3 = "#bad2ff"
export const blue4 = "#8aafff"
export const blue5 = "#507fff"
export const blue6 = "#2b52ff"
export const blue7 = "#1733d5"
export const blue8 = "#09209c"
export const blue9 = "#061460"
export const blue10 = "#030c34"

/** Grayscale, 1 lightest to 9 darkest. */
export const gray1 = "#f8f9fb"
export const gray2 = "#eff1f4"
export const gray3 = "#dfe2e8"
export const gray4 = "#cbcfd7"
export const gray5 = "#aab0bb"
export const gray6 = "#7c8390"
export const gray7 = "#576071"
export const gray8 = "#292e37"
export const gray9 = "#141719"

/**
 * Accent spectrum, 9 hues x 5 levels, 1 lightest to 5 darkest. The brand document scopes it to
 * contents, marketing and graphics; a product surface reaches into it only for the roles the brand
 * leaves undefined, which is every status and every syntax colour.
 */
export const teal1 = "#dcfffe"
export const teal2 = "#b9fffd"
export const teal3 = "#6ff4f0"
export const teal4 = "#00b5c2"
export const teal5 = "#006a7a"
export const sky1 = "#e4f0ff"
export const sky2 = "#bad9ff"
export const sky3 = "#2f8dff"
export const sky4 = "#0e51b6"
export const sky5 = "#002a68"
export const violet1 = "#f2e9ff"
export const violet2 = "#d4b3ff"
export const violet3 = "#8944ff"
export const violet4 = "#4500ac"
export const violet5 = "#140042"
export const pink1 = "#ffe3fc"
export const pink2 = "#ffb2f6"
export const pink3 = "#ff39ba"
export const pink4 = "#8a0061"
export const pink5 = "#380037"
export const red1 = "#ffe8e1"
export const red2 = "#ffc2ba"
export const red3 = "#ff5452"
export const red4 = "#a31310"
export const red5 = "#560100"
export const orange1 = "#ffedda"
export const orange2 = "#ffd5ab"
export const orange3 = "#ff9c1b"
export const orange4 = "#ae5100"
export const orange5 = "#5c2d00"
export const yellow1 = "#fff7cc"
export const yellow2 = "#ffed94"
export const yellow3 = "#ffda1e"
export const yellow4 = "#d2a100"
export const yellow5 = "#734f00"
export const lime1 = "#f2ffc3"
export const lime2 = "#e5ff81"
export const lime3 = "#cffd21"
export const lime4 = "#89ad00"
export const lime5 = "#2f5f00"
export const green1 = "#d6ffe1"
export const green2 = "#a6ffbf"
export const green3 = "#29e474"
export const green4 = "#00864a"
export const green5 = "#004829"

/**
 * The two dark steps the brand scale does not contain.
 *
 * Gray 9 is the dark background and Gray 8 is the next step up, twelve points of lightness away, so
 * a raised surface would jump the whole gap at once. The console's stylesheet answers with
 * `color-mix(in srgb, var(--rr-gray-8) 45%, var(--rr-gray-9))`; a terminal has no `color-mix`, so
 * the mix is resolved here instead, by the same sRGB arithmetic and the same rounding a browser
 * applies. Two more dark steps in the brand scale would remove the need for both.
 */
export function mix(from: string, to: string, ratio: number) {
  const a = channels(from)
  const b = channels(to)
  return `#${a.map((value, index) => component(value * ratio + (b[index] ?? 0) * (1 - ratio))).join("")}`
}

/** Relative luminance and contrast, WCAG 2.1 definitions, so a surface can check its own pairs. */
export function luminance(color: string) {
  const [r, g, b] = channels(color).map((value) => {
    const unit = value / 255
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
}

export function contrast(one: string, two: string) {
  const a = luminance(one)
  const b = luminance(two)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function channels(color: string) {
  const hex = color.replace("#", "")
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
}

function component(value: number) {
  return Math.round(value).toString(16).padStart(2, "0")
}

/**
 * Type. Pretendard is the single Redrob product family and the only approved product typeface: it
 * carries Latin and Hangul in one face, so Korean is not a fallback, it is the same font.
 *
 * `Pretendard Variable` is the family the variable build registers, bare `Pretendard` covers an OS
 * install or the static build, and the system stack is the last resort. These stacks are for browser
 * surfaces only. A terminal's font is chosen in the terminal, and no escape sequence can change it.
 */
export const fontSans =
  '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

/** A deliberate alias, not a placeholder for a future display face: brand moments use the same
 *  family at a heavier weight and tighter tracking. */
export const fontDisplay = fontSans

/** Code only. The brand's monospace is JetBrains Mono, which no Redrob Code surface vendors, so the
 *  stack names it for machines that have it and falls through to the system face. */
export const fontMono =
  '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

/** The version of Pretendard the brand's CDN copy is pinned to, named in exactly one place. */
export const fontVersion = "1.3.9"
export const fontVariableWoff2 = `https://cdn.jsdelivr.net/npm/pretendard@${fontVersion}/dist/web/variable/woff2/PretendardVariable.woff2`

/** Radius, from the brand scale. Browser surfaces only; a terminal cell has no corner. */
export const radiusSm = "6px"
export const radiusMd = "10px"
export const radiusLg = "14px"
export const radiusXl = "18px"

export * as Brand from "./brand"
