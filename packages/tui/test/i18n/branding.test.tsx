/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { JSX } from "solid-js"
import type { TuiPluginApi, TuiPluginMeta } from "@redrob-code/plugin/tui"
import { tmpdir } from "../fixture/fixture"
import { LocaleHarness, localeState } from "../fixture/tui-locale"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { registerRedrobKeymap } from "../../src/keymap"
import { dict as en } from "../../src/i18n/en"
import { dict as ko } from "../../src/i18n/ko"
import sidebarFooterPlugin from "../../src/feature-plugins/sidebar/footer"

// This fork inherited its copy from opencode, so any spelling of the old name is a
// shipping bug wherever a user can read it. Infrastructure identifiers keep the old
// name on purpose — `.opencode` config discovery, the `opencode-*` npm plugins, the
// `/opencode` GitHub trigger — so the guard asserts on the two dictionaries and on a
// rendered frame instead of scanning source text.
const FORMER_NAME = /open[\s-]*code/i

// The sidebar footer used to compose the name from two adjacent literals, so only the
// composed frame catches it. `local` is what InstallationVersion reports for a build
// made from source, which is how the footer came to read "OpenCode local".
describe("product name", () => {
  test("no dictionary value names the former product", () => {
    const offenders = Object.entries({ en, ko }).flatMap(([locale, dict]) =>
      Object.entries(dict).flatMap(([key, value]) => (FORMER_NAME.test(value) ? [`${locale}:${key} ${value}`] : [])),
    )
    expect(offenders).toEqual([])
  })

  test("spells the product name the same way in both locales", () => {
    expect([en["app.name.first"], en["app.name.second"]].join(" ")).toBe("Redrob Code")
    expect([ko["app.name.first"], ko["app.name.second"]].join(" ")).toBe("레드롭 코드")

    const wrong = Object.entries({ en, ko }).flatMap(([locale, dict]) =>
      Object.entries(dict).flatMap(([key, value]) =>
        /RedrobCode|Redrob-Code/.test(value) ? [`${locale}:${key} ${value}`] : [],
      ),
    )
    expect(wrong).toEqual([])
  })

  test("the sidebar footer renders the product name beside the version", async () => {
    const english = await footer("en", "local")
    expect(english).toContain("Redrob Code (local)")
    expect(english).not.toMatch(FORMER_NAME)

    const korean = await footer("ko", "local")
    expect(korean).toContain("레드롭 코드 (로컬)")
    expect(korean).not.toMatch(FORMER_NAME)
  })

  test("the sidebar footer keeps a released version verbatim", async () => {
    expect(await footer("en", "1.2.3")).toContain("Redrob Code 1.2.3")
    expect(await footer("ko", "1.2.3")).toContain("레드롭 코드 1.2.3")
  })
})

async function footer(locale: "en" | "ko", version: string) {
  await using tmp = await tmpdir()
  const state = await localeState(tmp.path, locale)
  const config = createTuiResolvedConfig()

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    registerRedrobKeymap(keymap, renderer, config)

    return (
      <LocaleHarness root={tmp.path} state={state} keymap={keymap} config={config}>
        {view(locale, version)}
      </LocaleHarness>
    )
  }

  const app = await testRender(() => <Harness />, { width: 60, height: 12 })
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      await app.renderOnce()
      if (app.captureCharFrame().trim()) break
      await Bun.sleep(10)
    }
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

// Mounts the real builtin through the slot it registers, so the assertion sees the same
// element tree the sidebar renders.
function view(locale: "en" | "ko", version: string) {
  const slots: Record<string, ((ctx: unknown, props: { session_id: string }) => JSX.Element) | undefined> = {}
  const api = {
    ...createTuiPluginApi({ kv: { language: locale, dismissed_getting_started: true } }),
    app: { version },
    state: { provider: [], session: { get: () => undefined }, path: { directory: "/tmp/redrob" } },
    slots: {
      register(input: { slots: typeof slots }) {
        Object.assign(slots, input.slots)
        return () => {}
      },
    },
  } as unknown as TuiPluginApi

  void sidebarFooterPlugin.tui(api, undefined, meta)
  return slots.sidebar_footer?.(undefined, { session_id: "ses_branding" })
}

const meta = {
  id: "test",
  source: "internal",
  spec: "test",
  target: "test",
  first_time: 0,
  last_time: 0,
  time_changed: 0,
  load_count: 1,
  fingerprint: "test",
  state: "same",
} satisfies TuiPluginMeta
