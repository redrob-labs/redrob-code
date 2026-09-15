import type { TuiPluginApi } from "@redrob-code/plugin/tui"
import { createMemo, For, type Accessor } from "solid-js"
import { DEFAULT_THEMES, useTheme } from "../../context/theme"
import { useCommandShortcut } from "../../keymap"
import { useLanguage, type LanguageContext } from "../../context/language"
import type { TuiI18nKey } from "../../i18n"

const themeCount = Object.keys(DEFAULT_THEMES).length

type TipPart = { text: string; highlight: boolean }
type TipShortcut = Accessor<string>
type Shortcuts = {
  agentCycle: TipShortcut
  childFirst: TipShortcut
  childNext: TipShortcut
  childPrevious: TipShortcut
  commandList: TipShortcut
  editorOpen: TipShortcut
  helpShow: TipShortcut
  inputClear: TipShortcut
  inputNewline: TipShortcut
  inputPaste: TipShortcut
  inputUndo: TipShortcut
  leader: TipShortcut
  messagesCopy: TipShortcut
  messagesFirst: TipShortcut
  messagesLast: TipShortcut
  messagesPageDown: TipShortcut
  messagesPageUp: TipShortcut
  messagesToggleConceal: TipShortcut
  modelCycleRecent: TipShortcut
  modelList: TipShortcut
  sessionExport: TipShortcut
  sessionInterrupt: TipShortcut
  sessionList: TipShortcut
  sessionNew: TipShortcut
  sessionParent: TipShortcut
  sessionPinToggle: TipShortcut
  sessionQuickSwitch1: TipShortcut
  sessionQuickSwitch9: TipShortcut
  sessionSidebarToggle: TipShortcut
  sessionTimeline: TipShortcut
  statusView: TipShortcut
  terminalSuspend: TipShortcut
  themeList: TipShortcut
}
type TipContext = { keys: Shortcuts; t: LanguageContext["t"] }
// A bare key is a tip with nothing to interpolate. A function may return `undefined` to
// drop the tip out of rotation, which is how tips about unbound shortcuts disappear.
type Tip = TuiI18nKey | ((ctx: TipContext) => string | undefined)

function parse(tip: string): TipPart[] {
  const parts: TipPart[] = []
  const regex = /\{highlight\}(.*?)\{\/highlight\}/g
  const found = Array.from(tip.matchAll(regex))
  const state = found.reduce(
    (acc, match) => {
      const start = match.index ?? 0
      if (start > acc.index) {
        acc.parts.push({ text: tip.slice(acc.index, start), highlight: false })
      }
      acc.parts.push({ text: match[1], highlight: true })
      acc.index = start + match[0].length
      return acc
    },
    { parts, index: 0 },
  )

  if (state.index < tip.length) {
    parts.push({ text: tip.slice(state.index), highlight: false })
  }

  return parts
}

const NO_MODELS_TIP: TuiI18nKey = "tip.no_models"

function mark(value: string) {
  return `{highlight}${value}{/highlight}`
}

// Renders a tip that names one shortcut, or nothing when that shortcut is unbound.
function press(ctx: TipContext, key: TuiI18nKey, shortcut: string) {
  if (!shortcut) return undefined
  return ctx.t(key, { shortcut: mark(shortcut) })
}

// Slash command plus its bound shortcut, e.g. "/models or <leader>m".
function commandOr(ctx: TipContext, name: string, shortcut: string) {
  if (!shortcut) return mark(name)
  return ctx.t("tip.command_or", { command: mark(name), shortcut: mark(shortcut) })
}

function configShortcut(api: TuiPluginApi, command: string): TipShortcut {
  return () =>
    api.tuiConfig.keybinds
      .get(command)
      .map((binding) => api.keys.formatSequence(Array.from(api.keymap.parseKeySequence(binding.key))))
      .filter(Boolean)
      .join(", ")
}

export function Tips(props: { api: TuiPluginApi; connected?: boolean }) {
  const theme = useTheme().theme
  const language = useLanguage()
  const tipOffset = Math.random()
  const shortcuts: Shortcuts = {
    agentCycle: useCommandShortcut("agent.cycle"),
    childFirst: configShortcut(props.api, "session.child.first"),
    childNext: configShortcut(props.api, "session.child.next"),
    childPrevious: configShortcut(props.api, "session.child.previous"),
    commandList: useCommandShortcut("command.palette.show"),
    editorOpen: useCommandShortcut("prompt.editor"),
    helpShow: useCommandShortcut("help.show"),
    inputClear: useCommandShortcut("prompt.clear"),
    inputNewline: useCommandShortcut("input.newline"),
    inputPaste: useCommandShortcut("prompt.paste"),
    inputUndo: useCommandShortcut("input.undo"),
    leader: configShortcut(props.api, "leader"),
    messagesCopy: configShortcut(props.api, "messages.copy"),
    messagesFirst: configShortcut(props.api, "session.first"),
    messagesLast: configShortcut(props.api, "session.last"),
    messagesPageDown: configShortcut(props.api, "session.page.down"),
    messagesPageUp: configShortcut(props.api, "session.page.up"),
    messagesToggleConceal: configShortcut(props.api, "session.toggle.conceal"),
    modelCycleRecent: useCommandShortcut("model.cycle_recent"),
    modelList: useCommandShortcut("model.list"),
    sessionExport: configShortcut(props.api, "session.export"),
    sessionInterrupt: configShortcut(props.api, "session.interrupt"),
    sessionList: useCommandShortcut("session.list"),
    sessionNew: useCommandShortcut("session.new"),
    sessionParent: configShortcut(props.api, "session.parent"),
    sessionPinToggle: configShortcut(props.api, "session.pin.toggle"),
    sessionQuickSwitch1: useCommandShortcut("session.quick_switch.1"),
    sessionQuickSwitch9: useCommandShortcut("session.quick_switch.9"),
    sessionSidebarToggle: configShortcut(props.api, "session.sidebar.toggle"),
    sessionTimeline: configShortcut(props.api, "session.timeline"),
    statusView: useCommandShortcut("redrob.status"),
    terminalSuspend: useCommandShortcut("terminal.suspend"),
    themeList: useCommandShortcut("theme.switch"),
  }
  const text = createMemo(() => {
    const ctx: TipContext = { keys: shortcuts, t: language.t }
    if (props.connected === false) return language.t(NO_MODELS_TIP)
    const tips = [...TIPS, process.platform !== "win32" ? TERMINAL_SUSPEND_TIP : INPUT_UNDO_TIP].flatMap((item) => {
      const value = typeof item === "string" ? language.t(item) : item(ctx)
      return value ? [value] : []
    })
    return tips[Math.floor(tipOffset * tips.length)] ?? language.t(NO_MODELS_TIP)
  }, language.t(NO_MODELS_TIP))
  const parts = createMemo(() => parse(text()))

  return (
    <box flexDirection="row" maxWidth="100%">
      <text flexShrink={0} style={{ fg: theme.warning }}>
        ● {language.t("home.tip.label")}{" "}
      </text>
      <text flexShrink={1} wrapMode="word">
        <For each={parts()}>
          {(part) => <span style={{ fg: part.highlight ? theme.text : theme.textMuted }}>{part.text}</span>}
        </For>
      </text>
    </box>
  )
}

const TIPS: Tip[] = [
  "tip.attach_files",
  "tip.shell_prefix",
  (ctx) => press(ctx, "tip.agent_cycle", ctx.keys.agentCycle()),
  "tip.undo",
  "tip.redo",
  "tip.share",
  "tip.drag_drop",
  (ctx) => press(ctx, "tip.paste_images", ctx.keys.inputPaste()),
  (ctx) => ctx.t("tip.editor", { command: commandOr(ctx, "/editor", ctx.keys.editorOpen()) }),
  "tip.init",
  (ctx) => ctx.t("tip.models", { command: commandOr(ctx, "/models", ctx.keys.modelList()) }),
  (ctx) => ctx.t("tip.themes", { command: commandOr(ctx, "/themes", ctx.keys.themeList()), count: themeCount }),
  (ctx) => ctx.t("tip.new_session", { command: commandOr(ctx, "/new", ctx.keys.sessionNew()) }),
  (ctx) => ctx.t("tip.sessions", { command: commandOr(ctx, "/sessions", ctx.keys.sessionList()) }),
  (ctx) => press(ctx, "tip.pin_session", ctx.keys.sessionPinToggle()),
  (ctx) =>
    ctx.keys.sessionQuickSwitch1() && ctx.keys.sessionQuickSwitch9()
      ? ctx.t("tip.quick_switch", {
          first: mark(ctx.keys.sessionQuickSwitch1()),
          last: mark(ctx.keys.sessionQuickSwitch9()),
        })
      : undefined,
  "tip.compact",
  (ctx) => ctx.t("tip.export", { command: commandOr(ctx, "/export", ctx.keys.sessionExport()) }),
  (ctx) => press(ctx, "tip.copy_message", ctx.keys.messagesCopy()),
  (ctx) => press(ctx, "tip.command_palette", ctx.keys.commandList()),
  "tip.connect",
  (ctx) => press(ctx, "tip.leader", ctx.keys.leader()),
  (ctx) => press(ctx, "tip.model_cycle", ctx.keys.modelCycleRecent()),
  (ctx) => press(ctx, "tip.sidebar", ctx.keys.sessionSidebarToggle()),
  (ctx) =>
    ctx.keys.messagesPageUp() && ctx.keys.messagesPageDown()
      ? ctx.t("tip.page_navigation", {
          up: mark(ctx.keys.messagesPageUp()),
          down: mark(ctx.keys.messagesPageDown()),
        })
      : undefined,
  (ctx) => press(ctx, "tip.first_message", ctx.keys.messagesFirst()),
  (ctx) => press(ctx, "tip.last_message", ctx.keys.messagesLast()),
  (ctx) => press(ctx, "tip.newline", ctx.keys.inputNewline()),
  (ctx) => press(ctx, "tip.clear_input", ctx.keys.inputClear()),
  (ctx) => press(ctx, "tip.interrupt", ctx.keys.sessionInterrupt()),
  "tip.plan_agent",
  "tip.subagents",
  (ctx) => {
    const items = [
      ctx.keys.sessionParent(),
      ctx.keys.childFirst(),
      ctx.keys.childPrevious(),
      ctx.keys.childNext(),
    ].filter(Boolean)
    if (!items.length) return undefined
    return ctx.t("tip.parent_child", { shortcuts: items.map(mark).join(" / ") })
  },
  "tip.config_files",
  "tip.global_config",
  "tip.schema",
  "tip.default_model",
  "tip.keybind_override",
  "tip.keybind_none",
  "tip.mcp_config",
  "tip.custom_commands",
  "tip.command_arguments",
  "tip.shell_backticks",
  "tip.custom_agents",
  "tip.agent_permissions",
  "tip.bash_patterns",
  "tip.deny_destructive",
  "tip.ask_git_push",
  "tip.formatter_enable",
  "tip.formatter_disable",
  "tip.formatter_custom",
  "tip.lsp_enable",
  "tip.custom_tools",
  "tip.tool_scripts",
  "tip.plugin_hooks",
  "tip.plugin_notifications",
  "tip.plugin_guard",
  "tip.cli_run",
  "tip.cli_continue",
  "tip.cli_attach_files",
  "tip.cli_json",
  "tip.cli_serve",
  "tip.cli_run_attach",
  "tip.cli_upgrade",
  "tip.cli_auth_list",
  "tip.cli_agent_create",
  "tip.github_slash",
  "tip.github_install",
  "tip.github_fix",
  "tip.github_oc",
  "tip.theme_system",
  "tip.theme_files",
  "tip.theme_variants",
  "tip.theme_xterm",
  "tip.config_env",
  "tip.config_file",
  "tip.instructions",
  "tip.temperature",
  "tip.steps",
  "tip.disable_tools",
  "tip.disable_mcp_tools",
  "tip.agent_tool_override",
  "tip.share_auto",
  "tip.share_disabled",
  "tip.unshare",
  "tip.doom_loop",
  "tip.external_directory",
  "tip.debug_config",
  "tip.print_logs",
  (ctx) => ctx.t("tip.timeline", { command: commandOr(ctx, "/timeline", ctx.keys.sessionTimeline()) }),
  (ctx) => press(ctx, "tip.conceal", ctx.keys.messagesToggleConceal()),
  (ctx) => ctx.t("tip.status", { command: commandOr(ctx, "/status", ctx.keys.statusView()) }),
  "tip.scroll_acceleration",
  (ctx) => press(ctx, "tip.username_palette", ctx.keys.commandList()) ?? ctx.t("tip.username"),
  "tip.docker",
  "tip.agents_md",
  "tip.review",
  (ctx) => ctx.t("tip.help", { command: commandOr(ctx, "/help", ctx.keys.helpShow()) }),
  "tip.rename",
]

const INPUT_UNDO_TIP: Tip = (ctx) => press(ctx, "tip.input_undo", ctx.keys.inputUndo())
const TERMINAL_SUSPEND_TIP: Tip = (ctx) => press(ctx, "tip.terminal_suspend", ctx.keys.terminalSuspend())
