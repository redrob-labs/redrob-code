import { expect, mock, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { TuiPluginApi } from "@redrob-code/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@redrob-code/core/effect/app-node-builder"
import { Global } from "@redrob-code/core/global"
import { tmpdir } from "./fixture/fixture"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory } from "./fixture/tui-sdk"

// Runs the whole app headless and reads both lists off the screen, so a command that is
// registered but filtered out of the ctrl+p palette or the / list fails here
// (mckinley-and-rice/redrob-chat#1962). One app instance covers both languages: a second
// instance in the same file receives every typed key twice.
test("log in and log out appear in the ctrl+p palette and the / list, in English and Korean", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), JSON.stringify({ language: "en" }))

  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  void mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch()
  let api!: TuiPluginApi
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  async function frameWith(text: string) {
    let frame = ""
    for (let attempt = 0; attempt < 50; attempt++) {
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      if (frame.includes(text)) break
      await Bun.sleep(20)
    }
    return frame
  }

  async function settle() {
    await Bun.sleep(100)
    await setup.renderOnce()
  }

  async function lists(text: { title: string; login: string; logout: string }) {
    api.keymap.dispatchCommand("command.palette.show")
    await frameWith(text.title)
    await settle()
    // English search text in both languages: the Korean palette finds 로그인 by its slash name.
    await setup.mockInput.typeText("log")
    const palette = await frameWith(text.logout)
    api.ui.dialog.clear()
    await settle()

    await setup.mockInput.typeText("/log")
    const slash = await frameWith(text.logout)
    for (let i = 0; i < 4; i++) setup.mockInput.pressBackspace()
    await settle()
    return { palette, slash }
  }

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start(input) {
            // The real host does this; without it every plugin slot, the home prompt included, renders empty.
            input.runtime.setupSlots(input.api)
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(
        // The TUI reads kv.json (the saved language) from Global.state; point it at a temp
        // dir so the test does not depend on the language saved on the machine running it.
        Effect.provideService(Global.Service, Global.Service.of(Global.make({ state }))),
        Effect.provide(AppNodeBuilder.build(Global.node)),
      ),
    )
    await ready
    await setup.renderOnce()

    const en = await lists({ title: "Commands", login: "Log in", logout: "Remove a saved sign-in" })
    expect(en.palette).toContain("Log in")
    expect(en.palette).toContain("Log out")
    expect(en.slash).toContain("/login")
    expect(en.slash).toContain("/logout")
    expect(en.slash).toContain("Sign in with a Redrob console key")

    api.kv.set("language", "ko")
    await settle()
    const ko = await lists({ title: "명령", login: "로그인", logout: "저장된 로그인을 지워요" })
    expect(ko.palette).toContain("로그인")
    expect(ko.palette).toContain("로그아웃")
    expect(ko.slash).toContain("/login")
    expect(ko.slash).toContain("/logout")
    expect(ko.slash).toContain("레드롭 콘솔 키로 로그인해요")

    api.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
