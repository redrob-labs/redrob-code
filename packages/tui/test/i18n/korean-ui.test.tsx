/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { createEffect, type JSX } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginMeta, TuiRouteDefinition } from "@redrob-code/plugin/tui"
import { tmpdir } from "../fixture/fixture"
import { LocaleHarness, localeState } from "../fixture/tui-locale"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { registerRedrobKeymap } from "../../src/keymap"
import { Tips } from "../../src/feature-plugins/home/tips-view"
import whichKeyPlugin from "../../src/feature-plugins/system/which-key"
import diffViewerPlugin from "../../src/feature-plugins/system/diff-viewer"
import { DialogWorkspaceUnavailable } from "../../src/component/dialog-workspace-unavailable"
import { DialogWorkspaceFileChanges } from "../../src/component/dialog-workspace-file-changes"
import { DialogSelect } from "../../src/ui/dialog-select"
import { DialogLanguageList } from "../../src/component/dialog-language-list"
import { useLanguage } from "../../src/context/language"

type PluginCommand = NonNullable<Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]["commands"]>[number]
type Mounted = {
  api: TuiPluginApi
  commands: Map<string, PluginCommand>
  keymap: ReturnType<typeof createDefaultOpenTuiKeymap>
}
type Screen = { frame: string; commands: Map<string, PluginCommand> }

const HANGUL = /[\uAC00-\uD7A3]/

async function screen(
  locale: "en" | "ko",
  view: (input: Mounted) => JSX.Element,
  options: {
    width?: number
    height?: number
    until?: string
    drive?: (app: Awaited<ReturnType<typeof testRender>>) => Promise<void>
  } = {},
): Promise<Screen> {
  await using tmp = await tmpdir()
  const state = await localeState(tmp.path, locale)
  const commands = new Map<string, PluginCommand>()
  const config = createTuiResolvedConfig()

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const registerLayer = keymap.registerLayer.bind(keymap)
    keymap.registerLayer = (layer) => {
      layer.commands?.forEach((command) => commands.set(command.name, command))
      return registerLayer(layer)
    }
    registerRedrobKeymap(keymap, renderer, config)

    return (
      <LocaleHarness root={tmp.path} state={state} keymap={keymap} config={config}>
        {view({ api: createTuiPluginApi({ keymap, kv: { language: locale } }), commands, keymap })}
      </LocaleHarness>
    )
  }

  const app = await testRender(() => <Harness />, { width: options.width ?? 80, height: options.height ?? 24 })
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      if (frame.includes(options.until ?? "") && frame.trim()) break
      await Bun.sleep(10)
    }
    if (options.drive) {
      await options.drive(app)
      await app.renderOnce()
      await Bun.sleep(20)
      await app.renderOnce()
    }
    return { frame: app.captureCharFrame(), commands }
  } finally {
    app.renderer.destroy()
  }
}

describe("home tips", () => {
  test("labels and renders the rotating corpus in Korean", async () => {
    const korean = await screen("ko", ({ api }) => <Tips api={api} connected={true} />, { until: "팁" })
    expect(korean.frame).toContain("팁")
    expect(korean.frame).toMatch(HANGUL)
  })

  test("renders the no-provider tip in Korean and keeps the command token", async () => {
    const korean = await screen("ko", ({ api }) => <Tips api={api} connected={false} />, { until: "/connect" })
    expect(korean.frame).toContain("/connect")
    expect(korean.frame).toContain("AI 공급자를 추가")

    const english = await screen("en", ({ api }) => <Tips api={api} connected={false} />, { until: "/connect" })
    expect(english.frame).toContain("add an AI provider")
    expect(english.frame).not.toMatch(HANGUL)
  })
})

describe("which-key", () => {
  test("translates the home hint", async () => {
    const korean = await screen("ko", ({ api }) => slot(whichKeyPlugin, api, "home_bottom"), { until: "단축키" })
    expect(korean.frame).toContain("키보드 단축키")

    const english = await screen("en", ({ api }) => slot(whichKeyPlugin, api, "home_bottom"), { until: "shortcuts" })
    expect(english.frame).toContain("Show keyboard shortcuts with")
  })

  test("translates the panel chrome, its group tabs and its own commands", async () => {
    const korean = await panel("ko")
    // Footer legend and the layout the toggle would switch to.
    expect(korean.frame).toContain("표시 전환")
    expect(korean.frame).toContain("겹쳐 표시")
    // Group tabs, translated from the English `category` identifier commands carry.
    expect(korean.frame).toContain("시스템")
    expect(korean.frame).toContain("세션")
    expect(korean.commands.get("which-key.toggle")?.title).toBe("키 바인딩 표시")
    expect(korean.commands.get("which-key.group.next")?.title).toBe("다음 키 바인딩 그룹")
    expect(korean.commands.get("which-key.scroll.up")?.desc).toBe("which-key 패널을 위로 스크롤합니다")

    const english = await panel("en")
    expect(english.frame).toContain("toggle")
    expect(english.frame).toContain("System")
    expect(english.commands.get("which-key.toggle")?.title).toBe("Show key bindings")
    expect(english.frame).not.toMatch(HANGUL)
  })

  test("translates a description that only exists as a config keybind default", async () => {
    // `session.rename` is bound by default and registered without a title, so the label
    // can only come from the keybind definition — the case that used to leak English.
    const korean = await panel("ko", "세션 이름 변경")
    expect(korean.frame).toContain("세션 이름 변경")
    expect(korean.frame).not.toContain("Rename session")

    const english = await panel("en", "Rename session")
    expect(english.frame).toContain("Rename session")
  })
})

describe("diff viewer", () => {
  test("translates the header, the source label, the file count and the empty state", async () => {
    const korean = await diffViewer("ko", "변경 사항이 없습니다")
    expect(korean.frame).toContain("변경 사항")
    expect(korean.frame).toContain("작업 트리")
    expect(korean.frame).toContain("파일 0개")
    expect(korean.frame).toContain("변경 사항이 없습니다")
    expect(korean.frame).not.toContain("working tree")

    const english = await diffViewer("en", "No diff!")
    expect(english.frame).toContain("working tree")
    expect(english.frame).toContain("0 files")
    expect(english.frame).toContain("No diff!")
    expect(english.frame).not.toMatch(HANGUL)
  })

  test("translates the footer shortcut hints and registers Korean command titles", async () => {
    // The footer packs the hints into narrow columns, so they are asserted per word.
    const korean = await diffViewer("ko", "헝크")
    expect(korean.frame).toContain("파일 트리")
    expect(korean.frame).toContain("헝크")
    expect(korean.frame).toContain("비교 대상")
    expect(korean.frame).toContain("검토")
    expect(korean.commands.get("diff.close")?.title).toBe("변경 사항 뷰어 닫기")
    expect(korean.commands.get("diff.mark_reviewed")?.title).toBe("선택한 파일의 검토 표시 전환")
    expect(korean.commands.get("diff.page.down")?.title).toBe("변경 사항 뷰어 한 페이지 아래로")

    const english = await diffViewer("en", "hunk")
    expect(english.commands.get("diff.close")?.title).toBe("Close diff viewer")
    expect(english.frame).toContain("hunk")
    expect(english.frame).toContain("mark")
  })
})

describe("workspace dialogs", () => {
  test("translates the unavailable-workspace recovery dialog", async () => {
    const korean = await screen("ko", () => <DialogWorkspaceUnavailable />, { until: "작업 영역" })
    expect(korean.frame).toContain("작업 영역을 사용할 수 없습니다")
    expect(korean.frame).toContain("새 작업 영역으로 복원할까요")
    expect(korean.frame).toContain("복원")
    expect(korean.frame).toContain("취소")

    const english = await screen("en", () => <DialogWorkspaceUnavailable />, { until: "Workspace" })
    expect(english.frame).toContain("Workspace Unavailable")
    expect(english.frame).toContain("restore")
    expect(english.frame).not.toMatch(HANGUL)
  })

  test("translates the file-changes prompt and keeps the file paths verbatim", async () => {
    const files = [{ file: "packages/tui/src/app.tsx", status: "modified" as const, additions: 3, deletions: 1 }]
    const korean = await screen("ko", () => <DialogWorkspaceFileChanges files={files} onSelect={() => {}} />, {
      until: "파일 변경 사항",
    })
    expect(korean.frame).toContain("파일 변경 사항이 있습니다")
    expect(korean.frame).toContain("세션과 함께 옮길까요")
    expect(korean.frame).toContain("아니요")
    expect(korean.frame).toContain("app.tsx")

    const english = await screen("en", () => <DialogWorkspaceFileChanges files={files} onSelect={() => {}} />, {
      until: "File Changes",
    })
    expect(english.frame).toContain("File Changes Found")
    expect(english.frame).toContain("yes")
  })
})

describe("language picker", () => {
  test("shows the Korean title with both locale labels in their own script", async () => {
    const korean = await screen("ko", () => <DialogLanguageList />, { until: "언어" })
    expect(korean.frame).toContain("언어")
    expect(korean.frame).toContain("한국어")
    expect(korean.frame).toContain("English")

    const english = await screen("en", () => <DialogLanguageList />, { until: "Language" })
    expect(english.frame).toContain("Language")
    expect(english.frame).toContain("한국어")
    expect(english.frame).toContain("English")
  })

  test("selecting Korean re-renders the picker in Korean", async () => {
    const seen: string[] = []
    let keymap: Mounted["keymap"] | undefined
    const switched = await screen(
      "en",
      (input) => {
        keymap = input.keymap
        return <LanguageSwitchProbe onLocale={(locale) => seen.push(locale)} />
      },
      {
        until: "Language",
        // Driven through the real binding layer the dialog registers, not by calling the
        // language context directly.
        drive: async (app) => {
          keymap!.dispatchCommand("dialog.select.next")
          await app.renderOnce()
          keymap!.dispatchCommand("dialog.select.submit")
        },
      },
    )
    expect(seen.at(-1)).toBe("ko")
    expect(switched.frame).toContain("언어")
  })
})

describe("common dialog chrome", () => {
  test("translates the shared select title, empty state and action legend", async () => {
    const korean = await screen(
      "ko",
      () => (
        <DialogSelect
          title="테마"
          options={[]}
          actions={[{ command: "session.delete", title: "삭제", onTrigger: () => {} }]}
          onSelect={() => {}}
        />
      ),
      { until: "테마" },
    )
    expect(korean.frame).toContain("테마")
    expect(korean.frame).toContain("결과가 없습니다")
    expect(korean.frame).toContain("삭제")

    const english = await screen("en", () => <DialogSelect title="Themes" options={[]} onSelect={() => {}} />, {
      until: "Themes",
    })
    expect(english.frame).toContain("No results found")
  })
})

function LanguageSwitchProbe(props: { onLocale: (locale: string) => void }) {
  const language = useLanguage()
  createEffect(() => props.onLocale(language.locale()))
  return <DialogLanguageList />
}

// The panel only mounts while it is pinned, and a command registered without a title is
// what forces the label to come from the keybind definition.
async function panel(locale: "en" | "ko", until?: string) {
  return screen(
    locale,
    ({ api, commands, keymap }) => {
      const view = slot(whichKeyPlugin, api, "app_bottom")
      keymap.registerLayer({
        commands: [{ name: "session.rename", category: "Session", run() {} }],
        bindings: api.tuiConfig.keybinds.get("session.rename"),
      })
      commands.get("which-key.toggle")?.run?.({} as never)
      return view
    },
    { width: 120, height: 40, until },
  )
}

async function diffViewer(locale: "en" | "ko", until: string) {
  return screen(
    locale,
    ({ api }) => {
      const routes: Record<string, () => JSX.Element> = {}
      const withRoute = {
        ...api,
        client: { vcs: { diff: async () => ({ data: [] }) } } as unknown as TuiPluginApi["client"],
        route: {
          register(list: TuiRouteDefinition[]) {
            list.forEach((route) => (routes[route.name] = () => route.render({ params: { mode: "git" } })))
            return () => {}
          },
          navigate() {},
          get current() {
            return { name: "diff", params: { mode: "git" } }
          },
        },
      } as unknown as TuiPluginApi
      void diffViewerPlugin.tui(withRoute, undefined, meta)
      return routes.diff?.()
    },
    { until },
  )
}

function slot(plugin: { tui: TuiPlugin }, api: TuiPluginApi, name: string) {
  const slots: Record<string, (() => JSX.Element) | undefined> = {}
  const withSlots = {
    ...api,
    slots: {
      register(input: { slots: Record<string, () => JSX.Element> }) {
        Object.assign(slots, input.slots)
        return () => {}
      },
    },
  } as unknown as TuiPluginApi
  void plugin.tui(withSlots, undefined, meta)
  return slots[name]?.()
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
