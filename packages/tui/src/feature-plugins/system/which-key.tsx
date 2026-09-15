/** @jsxImportSource @opentui/solid */
import { RGBA, TextAttributes, type KeyEvent, type Renderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { useBindings, useKeymapSelector } from "../../keymap"
import type { ActiveKey } from "@opentui/keymap"
import type { TuiPlugin, TuiPluginApi } from "@redrob-code/plugin/tui"
import { Brand } from "@redrob-code/core/theme/brand"
import type { BuiltinTuiPlugin } from "../builtins"
import { useLanguage, type LanguageContext } from "../../context/language"
import { kvTranslator, splitTemplate } from "../../i18n"
import { TuiKeybind } from "../../config/keybind"

const command = {
  toggle: "which-key.toggle",
  toggleLayout: "which-key.layout.toggle",
  togglePending: "which-key.pending.toggle",
  groupPrevious: "which-key.group.previous",
  groupNext: "which-key.group.next",
  scrollUp: "which-key.scroll.up",
  scrollDown: "which-key.scroll.down",
  pageUp: "which-key.page.up",
  pageDown: "which-key.page.down",
  home: "which-key.home",
  end: "which-key.end",
} as const

const LAYER_PRIORITY = 900
const KV_LAYOUT = "which_key_layout"
const KV_PENDING_PREVIEW = "which_key_pending_preview"
const toggleCommands = [command.toggle, command.toggleLayout, command.togglePending] as const
const scrollCommands = [
  command.scrollUp,
  command.scrollDown,
  command.pageUp,
  command.pageDown,
  command.home,
  command.end,
] as const
const panelCommands = [command.groupPrevious, command.groupNext, ...scrollCommands] as const
const COLUMN_GAP = 4
const TAB_GAP = 3
const MIN_TAB_GAP = 1
const TAB_CONTENT_GAP = 1
const MIN_COLUMN_WIDTH = 28
const MAX_COLUMN_WIDTH = 44
const PANEL_HEIGHT_RATIO = 0.3
const MIN_PANEL_HEIGHT = 8
const MAX_PANEL_HEIGHT = 16
const PANEL_TOP_PADDING = 1
const FOOTER_HEIGHT = 1
const FOOTER_MARGIN = 1

type Layout = "dock" | "overlay"

type Color = RGBA | string

type Skin = {
  panel: Color
  text: Color
  muted: Color
  subtle: Color
  key: Color
  accent: Color
  tab: Color
  tabText: Color
}

type Entry = {
  type: "entry"
  key: string
  label: string
  group: string
  continues: boolean
}

type Group = {
  label: string
  entries: Entry[]
}

type HeaderItem = { type: "tab"; group: Group } | { type: "scroll" }

type GroupHeader = {
  type: "group"
  label: string
}

type Item = Entry | GroupHeader

function text(value: unknown) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function ink(api: TuiPluginApi, name: string, fallback: string): Color {
  const value = Reflect.get(api.theme.current, name)
  if (typeof value === "string") return value
  if (value instanceof RGBA) return value
  return fallback
}

function skin(api: TuiPluginApi): Skin {
  // The fallbacks are the dark steps of the default theme, from the brand primitives, so a plugin
  // host that hands over a theme missing a role still paints in Redrob's colours rather than a
  // guessed xterm approximation.
  return {
    panel: ink(api, "backgroundMenu", Brand.mix(Brand.gray8, Brand.gray9, 0.45)),
    text: ink(api, "text", Brand.gray1),
    muted: ink(api, "textMuted", Brand.gray5),
    subtle: ink(api, "borderSubtle", Brand.gray7),
    key: ink(api, "warning", Brand.orange3),
    accent: ink(api, "primary", Brand.blue4),
    tab: ink(api, "primary", Brand.blue4),
    tabText: ink(api, "selectedListItemText", Brand.gray9),
  }
}

function activeKeyLabel(language: LanguageContext, active: ActiveKey<Renderable, KeyEvent>) {
  const unknown = language.t("palette.category.unknown")
  if (active.continues) return text(active.tokenName) ?? text(active.display) ?? unknown
  // A binding that only carries a config default has its English `desc` baked in at
  // config resolve time, so translate through the command name instead.
  const commandName = typeof active.command === "string" ? active.command : text(active.bindingAttrs?.cmd)
  const defaultKey = commandName ? TuiKeybind.CommandDescriptionKeys[commandName] : undefined
  return (
    text(active.commandAttrs?.title) ??
    (defaultKey ? language.t(defaultKey) : undefined) ??
    text(active.bindingAttrs?.desc) ??
    text(active.commandAttrs?.desc) ??
    unknown
  )
}

function activeKeyGroup(language: LanguageContext, active: ActiveKey<Renderable, KeyEvent>) {
  if (active.continues) return language.category("System")!
  return (
    language.category(active.commandAttrs?.category) ??
    language.category(active.bindingAttrs?.group) ??
    language.t("palette.category.unknown")
  )
}

function activeKeyEntry(api: TuiPluginApi, language: LanguageContext, active: ActiveKey<Renderable, KeyEvent>): Entry {
  const key = api.keys.formatSequence([
    {
      stroke: active.stroke,
      display: active.display,
      tokenName: active.tokenName,
    },
  ])
  const label = activeKeyLabel(language, active)
  return {
    type: "entry",
    key,
    label: active.continues ? `+${label}` : label,
    group: activeKeyGroup(language, active),
    continues: active.continues,
  }
}

function grouped(entries: Entry[]): Group[] {
  const map = new Map<string, Entry[]>()
  for (const entry of entries) map.set(entry.group, [...(map.get(entry.group) ?? []), entry])
  return [...map]
    .map(([label, entries]) => ({
      label,
      entries: entries.toSorted(
        (a, b) =>
          Number(b.continues) - Number(a.continues) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
      ),
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label))
}

function commandShortcut(api: TuiPluginApi, name: string) {
  return useKeymapSelector((keymap) =>
    api.keys.formatSequence(
      keymap.getCommandBindings({ visibility: "registered", commands: [name] }).get(name)?.[0]?.sequence,
    ),
  )
}

function layout(value: unknown): Layout {
  if (value === "overlay") return "overlay"
  return "dock"
}

function HomeHint(props: { api: TuiPluginApi }) {
  const trigger = commandShortcut(props.api, command.toggle)
  const look = createMemo(() => skin(props.api))
  const language = useLanguage()
  // The shortcut is a keyboard legend that keeps its own colour, so the sentence is split
  // around the placeholder instead of interpolated.
  const parts = createMemo(() => splitTemplate(language.t("whichkey.home_hint"), "shortcut"))

  return (
    <box width="100%" maxWidth={75} alignItems="center" paddingTop={1} flexShrink={0}>
      <text fg={look().muted} wrapMode="none">
        {parts()[0]}
        <span style={{ fg: look().subtle }}>{trigger() || command.toggle}</span>
        {parts()[1]}
      </text>
    </box>
  )
}

function WhichKeyPanel(props: {
  api: TuiPluginApi
  layout: Layout
  mode: () => Layout
  pendingPreview: () => boolean
  pinned: () => boolean
}) {
  const dimensions = useTerminalDimensions()
  const language = useLanguage()
  const [offset, setOffset] = createSignal(0)
  const [activeGroup, setActiveGroup] = createSignal<string | undefined>()
  const pending = useKeymapSelector((keymap) => keymap.getPendingSequence())
  const active = useKeymapSelector((keymap) => keymap.getActiveKeys({ includeMetadata: true }))
  const pendingActive = createMemo(() => pending().length > 0 && active().length > 0)
  const pendingAutoVisible = createMemo(() => props.mode() === "overlay" && props.pendingPreview() && pendingActive())
  const visible = createMemo(() => props.pinned() || pendingAutoVisible())
  const pendingMode = createMemo(() => visible() && pendingActive())
  const left = 0
  const width = createMemo(() => Math.max(1, dimensions().width))
  const panelHeight = createMemo(() =>
    Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, Math.floor(dimensions().height * PANEL_HEIGHT_RATIO))),
  )
  const contentWidth = createMemo(() => Math.max(1, width() - 2))
  const columns = createMemo(() =>
    Math.max(1, Math.min(3, Math.floor((contentWidth() + COLUMN_GAP) / (MAX_COLUMN_WIDTH + COLUMN_GAP)) || 1)),
  )
  const entries = createMemo(() => active().map((item) => activeKeyEntry(props.api, language, item)))
  const groups = createMemo(() => grouped(entries()))
  const tabsVisible = createMemo(() => !pendingMode() && groups().length > 0)
  const headerVisible = createMemo(() => tabsVisible() || pendingMode())
  const footerVisible = createMemo(() => !pendingMode())
  const rows = createMemo(() =>
    Math.max(
      1,
      panelHeight() -
        PANEL_TOP_PADDING -
        (headerVisible() ? 1 : 0) -
        (tabsVisible() ? TAB_CONTENT_GAP : 0) -
        (footerVisible() ? FOOTER_MARGIN + FOOTER_HEIGHT : 0),
    ),
  )
  const pageSize = createMemo(() => rows() * columns())
  const currentGroup = createMemo(() => {
    const group = activeGroup()
    return groups().find((item) => item.label === group) ?? groups()[0]
  })
  const activeEntries = createMemo(() => currentGroup()?.entries ?? [])
  const items = createMemo<Item[]>(() => {
    if (!pendingMode()) return activeEntries()
    return groups().flatMap((group) => [{ type: "group", label: group.label } satisfies GroupHeader, ...group.entries])
  })
  const maxOffset = createMemo(() => Math.max(0, items().length - pageSize()))
  const shown = createMemo(() => {
    const columnsItems: Item[][] = []
    let index = offset()
    for (let column = 0; column < columns() && index < items().length; column++) {
      const list: Item[] = []
      while (list.length < rows() && index < items().length) {
        list.push(items()[index]!)
        index += 1
      }
      columnsItems.push(list)
    }
    return columnsItems
  })
  const rowIndexes = createMemo(() => Array.from({ length: rows() }, (_, index) => index))
  const trigger = commandShortcut(props.api, command.toggle)
  const modeTrigger = commandShortcut(props.api, command.toggleLayout)
  const upActive = createMemo(() => offset() > 0)
  const downActive = createMemo(() => offset() < maxOffset())
  const scrollable = createMemo(() => maxOffset() > 0)
  const headerItems = createMemo<HeaderItem[]>(() => [
    ...(tabsVisible() ? groups().map((group) => ({ type: "tab" as const, group })) : []),
    ...(scrollable() ? [{ type: "scroll" as const }] : []),
  ])
  const tabGap = createMemo(() => {
    const itemCount = headerItems().length
    if (itemCount <= 1) return 0
    const itemWidth = headerItems().reduce(
      (sum, item) => sum + (item.type === "tab" ? item.group.label.length + 2 : 3),
      0,
    )
    return Math.max(MIN_TAB_GAP, Math.min(TAB_GAP, Math.floor((contentWidth() - itemWidth) / (itemCount - 1))))
  })
  const nextModeLabel = createMemo(() =>
    props.mode() === "dock" ? language.t("whichkey.layout.overlay") : language.t("whichkey.layout.dock"),
  )
  const look = createMemo(() => skin(props.api))
  const columnWidth = createMemo(() =>
    Math.max(1, Math.min(MAX_COLUMN_WIDTH, Math.floor((contentWidth() - (columns() - 1) * COLUMN_GAP) / columns()))),
  )
  const clamp = (value: number) => Math.max(0, Math.min(maxOffset(), value))
  const scroll = (delta: number) => setOffset((value) => clamp(value + delta))
  const moveGroup = (delta: number) => {
    if (pendingMode()) return
    const list = groups()
    if (!list.length) return
    const index = Math.max(
      0,
      list.findIndex((item) => item.label === currentGroup()?.label),
    )
    setActiveGroup(list[(index + delta + list.length) % list.length]!.label)
    setOffset(0)
  }

  useBindings(() => ({
    priority: 1000,
    enabled: visible(),
    commands: [
      {
        name: command.groupPrevious,
        title: language.t("whichkey.command.group_previous"),
        desc: language.t("whichkey.command.group_previous.desc"),
        category: "System",
        run() {
          moveGroup(-1)
        },
      },
      {
        name: command.groupNext,
        title: language.t("whichkey.command.group_next"),
        desc: language.t("whichkey.command.group_next.desc"),
        category: "System",
        run() {
          moveGroup(1)
        },
      },
      {
        name: command.scrollUp,
        title: language.t("whichkey.command.scroll_up"),
        desc: language.t("whichkey.command.scroll_up.desc"),
        category: "System",
        run() {
          scroll(-columns())
        },
      },
      {
        name: command.scrollDown,
        title: language.t("whichkey.command.scroll_down"),
        desc: language.t("whichkey.command.scroll_down.desc"),
        category: "System",
        run() {
          scroll(columns())
        },
      },
      {
        name: command.pageUp,
        title: language.t("whichkey.command.page_up"),
        desc: language.t("whichkey.command.page_up.desc"),
        category: "System",
        run() {
          scroll(-pageSize())
        },
      },
      {
        name: command.pageDown,
        title: language.t("whichkey.command.page_down"),
        desc: language.t("whichkey.command.page_down.desc"),
        category: "System",
        run() {
          scroll(pageSize())
        },
      },
      {
        name: command.home,
        title: language.t("whichkey.command.home"),
        desc: language.t("whichkey.command.home.desc"),
        category: "System",
        run() {
          setOffset(0)
        },
      },
      {
        name: command.end,
        title: language.t("whichkey.command.end"),
        desc: language.t("whichkey.command.end.desc"),
        category: "System",
        run() {
          setOffset(maxOffset())
        },
      },
    ],
    bindings: pendingMode()
      ? props.api.tuiConfig.keybinds.gather("which-key.scroll", scrollCommands)
      : props.api.tuiConfig.keybinds.gather("which-key.panel", panelCommands),
  }))

  createEffect(() => {
    if (pendingMode()) return
    const group = currentGroup()
    if (group?.label === activeGroup()) return
    setActiveGroup(group?.label)
  })

  createEffect(() => {
    if (pendingMode()) return
    activeGroup()
    setOffset(0)
  })

  createEffect(() => {
    if (!visible()) setOffset(0)
  })

  createEffect(() => {
    pending()
    setOffset(0)
  })

  createEffect(() => {
    setOffset((value) => clamp(value))
  })

  return (
    <Show when={visible()}>
      <box
        position={props.layout === "overlay" ? "absolute" : "relative"}
        zIndex={3500}
        left={left}
        bottom={props.layout === "overlay" ? 0 : undefined}
        width={dimensions().width}
        height={panelHeight()}
        backgroundColor={look().panel}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
        flexShrink={0}
        flexDirection="column"
      >
        <Show when={headerVisible()}>
          <box width="100%" flexDirection="row" justifyContent="center" gap={tabGap()} flexShrink={0}>
            <For each={headerItems()}>
              {(item) => (
                <Show
                  when={item.type === "tab" ? item.group : undefined}
                  fallback={
                    <box flexShrink={0}>
                      <text wrapMode="none">
                        <span style={{ fg: upActive() ? look().text : look().muted }}>↑</span>
                        <span style={{ fg: look().muted }}> </span>
                        <span style={{ fg: downActive() ? look().text : look().muted }}>↓</span>
                      </text>
                    </box>
                  }
                >
                  {(group) => {
                    const selected = createMemo(() => currentGroup()?.label === group().label)
                    return (
                      <box
                        paddingLeft={1}
                        paddingRight={1}
                        flexShrink={0}
                        backgroundColor={selected() ? look().tab : undefined}
                        onMouseDown={() => {
                          setActiveGroup(group().label)
                          setOffset(0)
                        }}
                      >
                        <text
                          fg={selected() ? look().tabText : look().muted}
                          attributes={selected() ? TextAttributes.BOLD : undefined}
                          wrapMode="none"
                        >
                          {group().label}
                        </text>
                      </box>
                    )
                  }}
                </Show>
              )}
            </For>
          </box>
        </Show>
        <Show when={tabsVisible()}>
          <box height={TAB_CONTENT_GAP} flexShrink={0} />
        </Show>
        <box height={rows()} flexShrink={0} flexDirection="column">
          <Show when={shown().length > 0} fallback={<text fg={look().muted}>{language.t("whichkey.empty")}</text>}>
            <For each={rowIndexes()}>
              {(row) => (
                <box width="100%" flexDirection="row" justifyContent="center" gap={COLUMN_GAP}>
                  <For each={shown()}>
                    {(column) => {
                      const item = createMemo(() => column[row])
                      const entry = createMemo(() => {
                        const value = item()
                        if (value?.type !== "entry") return undefined
                        return value
                      })
                      return (
                        <box width={columnWidth()} flexDirection="row" gap={1} justifyContent="space-between">
                          <Show when={item()}>
                            {(value) => (
                              <Show
                                when={entry()}
                                fallback={
                                  <text fg={look().accent} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
                                    {value().label}
                                  </text>
                                }
                              >
                                {(binding) => (
                                  <>
                                    <box flexGrow={1} minWidth={0}>
                                      <text
                                        fg={binding().continues ? look().accent : look().muted}
                                        wrapMode="none"
                                        truncate
                                      >
                                        {binding().label}
                                      </text>
                                    </box>
                                    <box flexShrink={0}>
                                      <text fg={look().text} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
                                        {binding().key}
                                      </text>
                                    </box>
                                  </>
                                )}
                              </Show>
                            )}
                          </Show>
                        </box>
                      )
                    }}
                  </For>
                </box>
              )}
            </For>
          </Show>
        </box>
        <Show when={footerVisible()}>
          <box height={FOOTER_MARGIN} flexShrink={0} />
          <box width="100%" flexDirection="row" justifyContent="space-between" flexShrink={0}>
            <box>
              <text fg={look().text} wrapMode="none">
                {language.t("whichkey.toggle")} <span style={{ fg: look().subtle }}>{trigger() || command.toggle}</span>
              </text>
            </box>
            <box>
              <text fg={look().text} wrapMode="none">
                {nextModeLabel()} <span style={{ fg: look().subtle }}>{modeTrigger() || command.toggleLayout}</span>
              </text>
            </box>
          </box>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  const [pinned, setPinned] = createSignal(false)
  const [mode, setMode] = createSignal(layout(api.kv.get(KV_LAYOUT, "dock")))
  const [pendingPreview, setPendingPreview] = createSignal(api.kv.get(KV_PENDING_PREVIEW, false))

  // Registration happens at plugin bootstrap, outside the render tree, so the titles are
  // getters over the persisted locale. Reading them from a Solid computation re-resolves
  // them when the language changes.
  api.keymap.registerLayer({
    priority: LAYER_PRIORITY,
    commands: [
      {
        name: command.toggle,
        get title() {
          return kvTranslator(api.kv).t("whichkey.command.toggle")
        },
        get desc() {
          return kvTranslator(api.kv).t("whichkey.command.toggle.desc")
        },
        category: "System",
        run() {
          setPinned((value) => !value)
        },
      },
      {
        name: command.toggleLayout,
        get title() {
          return kvTranslator(api.kv).t("whichkey.command.layout")
        },
        get desc() {
          return kvTranslator(api.kv).t("whichkey.command.layout.desc")
        },
        category: "System",
        run() {
          setMode((value) => {
            const next = value === "dock" ? "overlay" : "dock"
            api.kv.set(KV_LAYOUT, next)
            return next
          })
        },
      },
      {
        name: command.togglePending,
        get title() {
          return kvTranslator(api.kv).t("whichkey.command.pending")
        },
        get desc() {
          return kvTranslator(api.kv).t("whichkey.command.pending.desc")
        },
        category: "System",
        run() {
          setPendingPreview((value) => {
            api.kv.set(KV_PENDING_PREVIEW, !value)
            return !value
          })
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("which-key.toggle", toggleCommands),
  })

  api.slots.register({
    order: 200,
    slots: {
      home_bottom() {
        return <HomeHint api={api} />
      },
      app() {
        return (
          <Show when={mode() === "overlay"}>
            <WhichKeyPanel api={api} layout="overlay" mode={mode} pendingPreview={pendingPreview} pinned={pinned} />
          </Show>
        )
      },
      app_bottom() {
        return (
          <Show when={mode() === "dock"}>
            <WhichKeyPanel api={api} layout="dock" mode={mode} pendingPreview={pendingPreview} pinned={pinned} />
          </Show>
        )
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id: "which-key",
  enabled: false,
  tui,
}

export default plugin
