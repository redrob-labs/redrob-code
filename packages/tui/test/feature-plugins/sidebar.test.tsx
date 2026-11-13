/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { createStore } from "solid-js/store"
import type { JSX } from "solid-js"
import type { TuiPlugin, TuiPluginApi } from "@redrob-code/plugin/tui"
import { tmpdir } from "../fixture/fixture"
import { LocaleHarness, localeState } from "../fixture/tui-locale"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { registerRedrobKeymap } from "../../src/keymap"
import { panelNext, panelVisible } from "../../src/routes/session/panel"
import todoPlugin, { TODO_OPEN } from "../../src/feature-plugins/sidebar/todo"
import footerPlugin from "../../src/feature-plugins/sidebar/footer"

describe("side panel mode", () => {
  test("auto shows on wide terminals only", () => {
    expect(panelVisible("auto", true)).toBe(true)
    expect(panelVisible("auto", false)).toBe(false)
    expect(panelVisible("hide", true)).toBe(false)
    expect(panelVisible("show", false)).toBe(true)
  })

  test("the stored mode reproduces the toggled state after a restart", () => {
    for (const wide of [true, false]) {
      // Hide it, restart: still hidden. Show it again, restart: still shown.
      const hidden = panelNext(true, wide)
      expect(panelVisible(hidden, wide)).toBe(false)
      const shown = panelNext(panelVisible(hidden, wide), wide)
      expect(panelVisible(shown, wide)).toBe(true)
    }
    // Opening it on a narrow terminal is remembered, which a plain `auto` would forget.
    expect(panelNext(false, false)).toBe("show")
    expect(panelNext(false, true)).toBe("auto")
  })
})

const todos = [
  { id: "1", content: "first step", status: "in_progress", priority: "high" },
  { id: "2", content: "second step", status: "pending", priority: "high" },
  { id: "3", content: "third step", status: "pending", priority: "high" },
]

// A reactive KV, like the real kv.json store behind `api.kv`.
function kvStore(seed: Record<string, unknown>) {
  const [store, setStore] = createStore<Record<string, unknown>>({ ...seed })
  return {
    store,
    kv: {
      get: (key: string, fallback?: unknown) => store[key] ?? fallback,
      set: (key: string, value: unknown) => setStore(key, value),
      ready: true,
    },
  }
}

async function render(
  locale: "en" | "ko",
  plugin: { tui: TuiPlugin },
  slot: string,
  seed: Record<string, unknown>,
  drive?: (app: Awaited<ReturnType<typeof testRender>>) => Promise<void>,
) {
  await using tmp = await tmpdir()
  const state = await localeState(tmp.path, locale)
  const config = createTuiResolvedConfig()
  const store = { current: undefined as ReturnType<typeof kvStore> | undefined }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    registerRedrobKeymap(keymap, renderer, config)
    const kv = kvStore(seed)
    store.current = kv
    const base = createTuiPluginApi({ keymap, state: { session: { todo: () => todos as never } } })
    const slots: Record<string, (ctx: unknown, props: { session_id: string }) => JSX.Element> = {}
    const api = {
      ...base,
      kv: kv.kv,
      app: { version: "local" },
      state: {
        ...base.state,
        provider: [],
        path: { state: state, config: "", worktree: tmp.path, directory: tmp.path },
        vcs: undefined,
      },
      slots: {
        register(input: { slots: typeof slots }) {
          Object.assign(slots, input.slots)
          return () => {}
        },
      },
    } as unknown as TuiPluginApi
    void plugin.tui(api, undefined, {} as never)
    return (
      <LocaleHarness root={tmp.path} state={state} keymap={keymap} config={config}>
        {slots[slot]?.({}, { session_id: "ses" })}
      </LocaleHarness>
    )
  }

  const app = await testRender(() => <Harness />, { width: 42, height: 20 })
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      await app.renderOnce()
      if (app.captureCharFrame().trim()) break
      await Bun.sleep(10)
    }
    if (drive) {
      await drive(app)
      await app.renderOnce()
      await Bun.sleep(20)
      await app.renderOnce()
    }
    return { frame: app.captureCharFrame(), kv: store.current!.store }
  } finally {
    app.renderer.destroy()
  }
}

describe("todo section fold", () => {
  test("clicking the header folds the list and stores it", async () => {
    const result = await render("en", todoPlugin, "sidebar_content", {}, (app) => app.mockMouse.click(1, 0))
    expect(result.kv[TODO_OPEN]).toBe(false)
    expect(result.frame).toContain("▶")
    expect(result.frame).not.toContain("second step")
  })

  test("a stored fold is restored on the next start", async () => {
    const folded = await render("en", todoPlugin, "sidebar_content", { [TODO_OPEN]: false })
    expect(folded.frame).toContain("▶")
    expect(folded.frame).not.toContain("first step")

    const open = await render("en", todoPlugin, "sidebar_content", {})
    expect(open.frame).toContain("▼")
    expect(open.frame).toContain("third step")
  })
})

describe("panel footer hint", () => {
  test("names the user's real key for hiding the panel", async () => {
    const korean = await render("ko", footerPlugin, "sidebar_footer", {})
    expect(korean.frame).toContain("ctrl+x b 옆 패널 숨기기")

    const english = await render("en", footerPlugin, "sidebar_footer", {})
    expect(english.frame).toContain("ctrl+x b hide panel")
  })
})
