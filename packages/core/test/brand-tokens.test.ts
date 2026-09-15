/**
 * The brand token layer and the two Redrob Code surfaces that are not a terminal.
 *
 * `src/theme/brand.ts` is a transcription, so the specification is written out here independently:
 * a test that read the module twice would only prove the file equals itself. The rest measures the
 * wiring - that the OAuth callback pages and the docs site name these steps and no others, and that
 * the pairs they paint together clear their contrast minimum in both themes.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Brand } from "../src/theme/brand"
import { OauthCallbackPage } from "../src/oauth/page"

/**
 * Redrob Design's confirmed colour system, the same values the console's `globals.css` implements.
 * This is the answer the module has to match.
 */
const BRAND_PRIMITIVES: Record<string, string> = {
  blue: "#2b52ff",
  black: "#0a0b0c",
  white: "#ffffff",
  blue1: "#eff4ff",
  blue2: "#d9e6ff",
  blue3: "#bad2ff",
  blue4: "#8aafff",
  blue5: "#507fff",
  blue6: "#2b52ff",
  blue7: "#1733d5",
  blue8: "#09209c",
  blue9: "#061460",
  blue10: "#030c34",
  gray1: "#f8f9fb",
  gray2: "#eff1f4",
  gray3: "#dfe2e8",
  gray4: "#cbcfd7",
  gray5: "#aab0bb",
  gray6: "#7c8390",
  gray7: "#576071",
  gray8: "#292e37",
  gray9: "#141719",
  teal1: "#dcfffe",
  teal2: "#b9fffd",
  teal3: "#6ff4f0",
  teal4: "#00b5c2",
  teal5: "#006a7a",
  sky1: "#e4f0ff",
  sky2: "#bad9ff",
  sky3: "#2f8dff",
  sky4: "#0e51b6",
  sky5: "#002a68",
  violet1: "#f2e9ff",
  violet2: "#d4b3ff",
  violet3: "#8944ff",
  violet4: "#4500ac",
  violet5: "#140042",
  pink1: "#ffe3fc",
  pink2: "#ffb2f6",
  pink3: "#ff39ba",
  pink4: "#8a0061",
  pink5: "#380037",
  red1: "#ffe8e1",
  red2: "#ffc2ba",
  red3: "#ff5452",
  red4: "#a31310",
  red5: "#560100",
  orange1: "#ffedda",
  orange2: "#ffd5ab",
  orange3: "#ff9c1b",
  orange4: "#ae5100",
  orange5: "#5c2d00",
  yellow1: "#fff7cc",
  yellow2: "#ffed94",
  yellow3: "#ffda1e",
  yellow4: "#d2a100",
  yellow5: "#734f00",
  lime1: "#f2ffc3",
  lime2: "#e5ff81",
  lime3: "#cffd21",
  lime4: "#89ad00",
  lime5: "#2f5f00",
  green1: "#d6ffe1",
  green2: "#a6ffbf",
  green3: "#29e474",
  green4: "#00864a",
  green5: "#004829",
}

describe("Brand", () => {
  test("transcribes the brand's colour system exactly", () => {
    const module: Record<string, unknown> = Brand
    const declared = Object.fromEntries(
      Object.entries(module).flatMap(([name, value]) =>
        typeof value === "string" && value.startsWith("#") ? [[name, value] as const] : [],
      ),
    )
    expect(declared).toEqual(BRAND_PRIMITIVES)
  })

  test("Redrob Blue is Blue 6, not a second value beside it", () => {
    expect(Brand.blue).toBe(Brand.blue6)
  })

  test("mix resolves color-mix the way a browser does", () => {
    expect(Brand.mix(Brand.white, Brand.black, 1)).toBe(Brand.white)
    expect(Brand.mix(Brand.white, Brand.black, 0)).toBe(Brand.black)
    expect(Brand.mix("#000000", "#ffffff", 0.5)).toBe("#808080")
  })

  test("contrast follows the WCAG definition", () => {
    expect(Brand.contrast("#000000", "#ffffff")).toBeCloseTo(21, 5)
    expect(Brand.contrast(Brand.gray9, Brand.gray9)).toBeCloseTo(1, 5)
    // The two the console documents, so a slip in the luminance maths is caught by a known answer.
    expect(Brand.contrast(Brand.blue6, Brand.white)).toBeCloseTo(5.59, 1)
    expect(Brand.contrast(Brand.gray6, Brand.gray1)).toBeCloseTo(3.62, 1)
  })

  test("names Pretendard as the product family and nothing else", () => {
    expect(Brand.fontSans).toStartWith('"Pretendard Variable", Pretendard,')
    expect(Brand.fontDisplay).toBe(Brand.fontSans)
    for (const retired of ["Geist", "Inter", "Fraunces"]) {
      expect(Brand.fontSans).not.toContain(retired)
    }
    expect(Brand.fontVariableWoff2).toContain(`pretendard@${Brand.fontVersion}`)
  })
})

describe("OauthCallbackPage tokens", () => {
  const light = OauthCallbackPage.success({ provider: "xAI" })
  const dark = OauthCallbackPage.error("invalid_grant")

  test("speaks the console's semantic vocabulary, not OpenCode's", () => {
    expect(light).toContain("--rr-foreground")
    expect(light).toContain("--rr-muted-foreground")
    expect(light).toContain("--rr-destructive-soft")
    expect(light).not.toContain("--oc-")
    expect(light.toLowerCase()).not.toContain("opencode")
  })

  test("declares only brand primitives as colour values", () => {
    // Plus the one derived step: the brand scale has nothing between Gray 9 and Gray 8, so the raised
    // card is the console's mix of the two. Every other value must be a step someone drew.
    const allowed = [...Object.values(BRAND_PRIMITIVES), Brand.mix(Brand.gray8, Brand.gray9, 0.45)]
    const foreign = [...light.matchAll(/--rr-[a-z-]+:\s*(#[0-9a-f]{3,8})/g)]
      .flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
      .filter((hex) => !allowed.includes(hex))
    expect(foreign).toEqual([])
  })

  test("sets Pretendard on the body and the brand's mono on the detail block", () => {
    expect(light).toContain(`--rr-font-sans: ${Brand.fontSans}`)
    expect(light).toContain(`--rr-font-mono: ${Brand.fontMono}`)
    expect(light).toContain("font-family: var(--rr-font-sans)")
    expect(light).toContain("font-family: var(--rr-font-mono)")
  })

  test("stays self-contained, so it renders with no network", () => {
    // The page is shown when an authorization has just finished or just failed. It may not depend on
    // a webfont, a stylesheet or an icon it has to fetch, which is why Pretendard is named rather
    // than loaded.
    expect(dark).not.toContain("<link")
    expect(dark).not.toContain("@import")
    expect(dark).not.toContain("cdn.jsdelivr.net")
    expect(dark).not.toContain("https://fonts.")
  })

  test("carries no em dash in the copy it shows", () => {
    for (const page of [light, dark, OauthCallbackPage.bootstrap({ tokenPath: "/token", provider: "MCP" })]) {
      expect(page).not.toContain("\u2014")
    }
  })

  test("the pairs the card paints clear their contrast minimum", () => {
    const cardDark = Brand.mix(Brand.gray8, Brand.gray9, 0.45)
    const pairs: Array<[string, string, string, number]> = [
      // light: page Gray 1, card White, detail strip Red 1
      ["light headline", Brand.gray9, Brand.white, 4.5],
      ["light message", Brand.gray7, Brand.white, 4.5],
      ["light footnote", Brand.gray6, Brand.white, 3],
      ["light success icon", Brand.green5, Brand.white, 3],
      ["light error icon", Brand.red4, Brand.white, 3],
      ["light pending icon", Brand.blue6, Brand.white, 3],
      ["light detail text", Brand.gray9, Brand.red1, 4.5],
      ["light card boundary", Brand.gray3, Brand.gray1, 1],
      // dark: page Gray 9, card the Gray 8/9 mix, detail strip Red 5
      ["dark headline", Brand.gray1, cardDark, 4.5],
      ["dark message", Brand.gray5, cardDark, 4.5],
      ["dark footnote", Brand.gray6, cardDark, 3],
      ["dark success icon", Brand.green3, cardDark, 3],
      ["dark error icon", Brand.red3, cardDark, 3],
      ["dark pending icon", Brand.blue5, cardDark, 3],
      ["dark detail text", Brand.gray1, Brand.red5, 4.5],
    ]
    const short = pairs
      .map(([label, ink, surface, minimum]) => ({ label, ratio: Brand.contrast(ink, surface), minimum }))
      .filter((pair) => pair.ratio < pair.minimum)
    expect(short).toEqual([])
  })
})

describe("docs site branding", () => {
  const docs = path.join(import.meta.dir, "../../docs")
  const config = JSON.parse(readFileSync(path.join(docs, "docs.json"), "utf8"))

  test("is painted in Redrob Blue", () => {
    expect(config.colors).toEqual({ primary: Brand.blue6, light: Brand.blue5, dark: Brand.blue7 })
  })

  test("loads Pretendard, pinned to the version the brand names", () => {
    expect(config.fonts.heading.family).toBe("Pretendard Variable")
    expect(config.fonts.body.family).toBe("Pretendard Variable")
    for (const face of [config.fonts.heading, config.fonts.body]) {
      expect(face.source).toBe(Brand.fontVariableWoff2)
      expect(face.format).toBe("woff2")
    }
  })

  test("wears the Redrob wordmark rather than the starter kit's", () => {
    const identity = path.join(import.meta.dir, "../../identity")
    for (const [slot, asset] of [
      [config.logo.light, "logo-ornate-light.svg"],
      [config.logo.dark, "logo-ornate-dark.svg"],
      [config.favicon, "mark.svg"],
    ] as const) {
      expect(readFileSync(path.join(docs, slot), "utf8")).toBe(readFileSync(path.join(identity, asset), "utf8"))
    }
  })

  test("keeps no trace of the green it shipped with", () => {
    // The starter kit's palette and its logo gradients. Green is not a Redrob colour at any step.
    const abandoned = ["16a34a", "07c983", "15803d", "18e299", "4ade80", "0d9373"]
    const files = ["docs.json", "favicon.svg", "logo/light.svg", "logo/dark.svg"]
    const found = files.flatMap((file) => {
      const text = readFileSync(path.join(docs, file), "utf8").toLowerCase()
      return abandoned.filter((hex) => text.includes(hex)).map((hex) => `${file}: ${hex}`)
    })
    expect(found).toEqual([])
  })
})
