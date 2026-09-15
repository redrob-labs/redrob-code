export * as TuiKeybind from "./keybind"

import type { KeyEvent, Renderable } from "@opentui/core"
import type { Binding } from "@opentui/keymap"
import type { BindingCommandMap, BindingConfig, BindingDefaults } from "@opentui/keymap/extras"
import { Schema } from "effect"
import { dict, type TuiI18nKey } from "../i18n/en"

const KeyStroke = Schema.Struct({
  name: Schema.String,
  ctrl: Schema.optional(Schema.Boolean),
  shift: Schema.optional(Schema.Boolean),
  meta: Schema.optional(Schema.Boolean),
  super: Schema.optional(Schema.Boolean),
  hyper: Schema.optional(Schema.Boolean),
})

const BindingObject = Schema.StructWithRest(
  Schema.Struct({
    key: Schema.Union([Schema.String, KeyStroke]),
    event: Schema.optional(Schema.Literals(["press", "release"])),
    preventDefault: Schema.optional(Schema.Boolean),
    fallthrough: Schema.optional(Schema.Boolean),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

const BindingItem = Schema.Union([Schema.String, KeyStroke, BindingObject])
export const BindingValueSchema = Schema.Union([
  Schema.Literal(false),
  Schema.Literal("none"),
  BindingItem,
  Schema.Array(BindingItem),
])
export type BindingValueSchema = Schema.Schema.Type<typeof BindingValueSchema>

type Definition = {
  default: BindingValueSchema
  key: TuiI18nKey
  description: string
}

export const LeaderDefault = "ctrl+x"

// The English dictionary entry is the single source for a keybind description: the config
// JSON schema advertises it verbatim and the which-key panel resolves the same key in the
// active locale.
const keybind = (value: Definition["default"], key: TuiI18nKey): Definition => ({
  default: value,
  key,
  description: dict[key],
})

export const Definitions = {
  leader: keybind(LeaderDefault, "keybind.leader"),

  app_exit: keybind("ctrl+c,ctrl+d,<leader>q", "keybind.app_exit"),
  app_debug: keybind("none", "keybind.app_debug"),
  app_console: keybind("none", "keybind.app_console"),
  app_heap_snapshot: keybind("none", "keybind.app_heap_snapshot"),
  app_toggle_animations: keybind("none", "keybind.app_toggle_animations"),
  app_toggle_file_context: keybind("none", "keybind.app_toggle_file_context"),
  app_toggle_diffwrap: keybind("none", "keybind.app_toggle_diffwrap"),
  app_toggle_paste_summary: keybind("none", "keybind.app_toggle_paste_summary"),
  app_toggle_session_directory_filter: keybind("none", "keybind.app_toggle_session_directory_filter"),
  command_list: keybind("ctrl+p", "keybind.command_list"),
  help_show: keybind("none", "keybind.help_show"),
  docs_open: keybind("none", "keybind.docs_open"),
  diff_open: keybind("none", "keybind.diff_open"),
  diff_close: keybind("escape,q", "keybind.diff_close"),
  diff_toggle: keybind("enter,space", "keybind.diff_toggle"),
  diff_expand: keybind("right", "keybind.diff_expand"),
  diff_expand_all: keybind("E", "keybind.diff_expand_all"),
  diff_collapse: keybind("left", "keybind.diff_collapse"),
  diff_switch_focus: keybind("tab", "keybind.diff_switch_focus"),
  diff_next_hunk: keybind("]", "keybind.diff_next_hunk"),
  diff_previous_hunk: keybind("[", "keybind.diff_previous_hunk"),
  diff_next_file: keybind("n", "keybind.diff_next_file"),
  diff_previous_file: keybind("p", "keybind.diff_previous_file"),
  diff_toggle_file_tree: keybind("b", "keybind.diff_toggle_file_tree"),
  diff_single_patch: keybind("s", "keybind.diff_single_patch"),
  diff_switch_source: keybind("d", "keybind.diff_switch_source"),
  diff_toggle_view: keybind("v", "keybind.diff_toggle_view"),
  diff_help: keybind("?", "keybind.diff_help"),

  editor_open: keybind("<leader>e", "keybind.editor_open"),
  language_switch: keybind("none", "keybind.language_switch"),
  theme_list: keybind("<leader>t", "keybind.theme_list"),
  theme_switch_mode: keybind("none", "keybind.theme_switch_mode"),
  theme_mode_lock: keybind("none", "keybind.theme_mode_lock"),
  sidebar_toggle: keybind("<leader>b", "keybind.sidebar_toggle"),
  scrollbar_toggle: keybind("none", "keybind.scrollbar_toggle"),
  status_view: keybind("<leader>s", "keybind.status_view"),
  debug_view: keybind("none", "keybind.debug_view"),

  session_export: keybind("<leader>x", "keybind.session_export"),
  session_copy: keybind("none", "keybind.session_copy"),
  session_move: keybind("none", "keybind.session_move"),
  session_new: keybind("<leader>n", "keybind.session_new"),
  session_list: keybind("<leader>l", "keybind.session_list"),
  session_timeline: keybind("<leader>g", "keybind.session_timeline"),
  session_fork: keybind("none", "keybind.session_fork"),
  session_rename: keybind("ctrl+r", "keybind.session_rename"),
  session_delete: keybind("ctrl+d", "keybind.session_delete"),
  session_share: keybind("none", "keybind.session_share"),
  session_unshare: keybind("none", "keybind.session_unshare"),
  session_interrupt: keybind("escape", "keybind.session_interrupt"),
  session_background: keybind("ctrl+b", "keybind.session_background"),
  session_compact: keybind("<leader>c", "keybind.session_compact"),
  session_toggle_timestamps: keybind("none", "keybind.session_toggle_timestamps"),
  session_toggle_generic_tool_output: keybind("none", "keybind.session_toggle_generic_tool_output"),
  session_queued_prompts: keybind("<leader>q", "keybind.session_queued_prompts"),
  session_child_first: keybind("<leader>down", "keybind.session_child_first"),
  session_child_cycle: keybind("right", "keybind.session_child_cycle"),
  session_child_cycle_reverse: keybind("left", "keybind.session_child_cycle_reverse"),
  session_parent: keybind("up", "keybind.session_parent"),
  session_pin_toggle: keybind("ctrl+f", "keybind.session_pin_toggle"),
  session_quick_switch_1: keybind("<leader>1", "keybind.session_quick_switch_1"),
  session_quick_switch_2: keybind("<leader>2", "keybind.session_quick_switch_2"),
  session_quick_switch_3: keybind("<leader>3", "keybind.session_quick_switch_3"),
  session_quick_switch_4: keybind("<leader>4", "keybind.session_quick_switch_4"),
  session_quick_switch_5: keybind("<leader>5", "keybind.session_quick_switch_5"),
  session_quick_switch_6: keybind("<leader>6", "keybind.session_quick_switch_6"),
  session_quick_switch_7: keybind("<leader>7", "keybind.session_quick_switch_7"),
  session_quick_switch_8: keybind("<leader>8", "keybind.session_quick_switch_8"),
  session_quick_switch_9: keybind("<leader>9", "keybind.session_quick_switch_9"),

  stash_delete: keybind("ctrl+d", "keybind.stash_delete"),
  model_provider_list: keybind("ctrl+a", "keybind.model_provider_list"),
  model_favorite_toggle: keybind("ctrl+f", "keybind.model_favorite_toggle"),
  model_list: keybind("<leader>m", "keybind.model_list"),
  model_cycle_recent: keybind("f2", "keybind.model_cycle_recent"),
  model_cycle_recent_reverse: keybind("shift+f2", "keybind.model_cycle_recent_reverse"),
  model_cycle_favorite: keybind("none", "keybind.model_cycle_favorite"),
  model_cycle_favorite_reverse: keybind("none", "keybind.model_cycle_favorite_reverse"),
  mcp_list: keybind("none", "keybind.mcp_list"),
  provider_connect: keybind("none", "keybind.provider_connect"),
  console_org_switch: keybind("none", "keybind.console_org_switch"),
  agent_list: keybind("<leader>a", "keybind.agent_list"),
  agent_cycle: keybind("tab", "keybind.agent_cycle"),
  agent_cycle_reverse: keybind("shift+tab", "keybind.agent_cycle_reverse"),
  variant_cycle: keybind("ctrl+t", "keybind.variant_cycle"),
  variant_list: keybind("none", "keybind.variant_list"),

  messages_page_up: keybind("pageup,ctrl+alt+b", "keybind.messages_page_up"),
  messages_page_down: keybind("pagedown,ctrl+alt+f", "keybind.messages_page_down"),
  messages_line_up: keybind("ctrl+alt+y", "keybind.messages_line_up"),
  messages_line_down: keybind("ctrl+alt+e", "keybind.messages_line_down"),
  messages_half_page_up: keybind("ctrl+alt+u", "keybind.messages_half_page_up"),
  messages_half_page_down: keybind("ctrl+alt+d", "keybind.messages_half_page_down"),
  messages_first: keybind("ctrl+g,home", "keybind.messages_first"),
  messages_last: keybind("ctrl+alt+g,end", "keybind.messages_last"),
  messages_next: keybind("none", "keybind.messages_next"),
  messages_previous: keybind("none", "keybind.messages_previous"),
  messages_last_user: keybind("none", "keybind.messages_last_user"),
  messages_copy: keybind("<leader>y", "keybind.messages_copy"),
  messages_undo: keybind("<leader>u", "keybind.messages_undo"),
  messages_redo: keybind("<leader>r", "keybind.messages_redo"),
  messages_toggle_conceal: keybind("<leader>h", "keybind.messages_toggle_conceal"),
  tool_details: keybind("none", "keybind.tool_details"),
  display_thinking: keybind("none", "keybind.display_thinking"),

  prompt_submit: keybind("none", "keybind.prompt_submit"),
  prompt_editor_context_clear: keybind("none", "keybind.prompt_editor_context_clear"),
  prompt_skills: keybind("none", "keybind.prompt_skills"),
  prompt_stash: keybind("none", "keybind.prompt_stash"),
  prompt_stash_pop: keybind("none", "keybind.prompt_stash_pop"),
  prompt_stash_list: keybind("none", "keybind.prompt_stash_list"),
  workspace_set: keybind("none", "keybind.workspace_set"),

  input_clear: keybind("ctrl+c", "keybind.input_clear"),
  input_paste: keybind({ key: "ctrl+v", preventDefault: false }, "keybind.input_paste"),
  input_submit: keybind("return", "keybind.input_submit"),
  input_newline: keybind("shift+return,ctrl+return,alt+return,ctrl+j", "keybind.input_newline"),
  input_move_left: keybind("left,ctrl+b", "keybind.input_move_left"),
  input_move_right: keybind("right,ctrl+f", "keybind.input_move_right"),
  input_move_up: keybind("up", "keybind.input_move_up"),
  input_move_down: keybind("down", "keybind.input_move_down"),
  input_select_left: keybind("shift+left", "keybind.input_select_left"),
  input_select_right: keybind("shift+right", "keybind.input_select_right"),
  input_select_up: keybind("shift+up", "keybind.input_select_up"),
  input_select_down: keybind("shift+down", "keybind.input_select_down"),
  input_line_home: keybind("ctrl+a", "keybind.input_line_home"),
  input_line_end: keybind("ctrl+e", "keybind.input_line_end"),
  input_select_line_home: keybind("ctrl+shift+a", "keybind.input_select_line_home"),
  input_select_line_end: keybind("ctrl+shift+e", "keybind.input_select_line_end"),
  input_visual_line_home: keybind("alt+a", "keybind.input_visual_line_home"),
  input_visual_line_end: keybind("alt+e", "keybind.input_visual_line_end"),
  input_select_visual_line_home: keybind("alt+shift+a", "keybind.input_select_visual_line_home"),
  input_select_visual_line_end: keybind("alt+shift+e", "keybind.input_select_visual_line_end"),
  input_buffer_home: keybind("home", "keybind.input_buffer_home"),
  input_buffer_end: keybind("end", "keybind.input_buffer_end"),
  input_select_buffer_home: keybind("shift+home", "keybind.input_select_buffer_home"),
  input_select_buffer_end: keybind("shift+end", "keybind.input_select_buffer_end"),
  input_delete_line: keybind("ctrl+shift+d", "keybind.input_delete_line"),
  input_delete_to_line_end: keybind("ctrl+k", "keybind.input_delete_to_line_end"),
  input_delete_to_line_start: keybind("ctrl+u", "keybind.input_delete_to_line_start"),
  input_backspace: keybind("backspace,shift+backspace", "keybind.input_backspace"),
  input_delete: keybind("ctrl+d,delete,shift+delete", "keybind.input_delete"),
  input_undo: keybind("ctrl+-,super+z", "keybind.input_undo"),
  input_redo: keybind("ctrl+.,super+shift+z", "keybind.input_redo"),
  input_word_forward: keybind("alt+f,alt+right,ctrl+right", "keybind.input_word_forward"),
  input_word_backward: keybind("alt+b,alt+left,ctrl+left", "keybind.input_word_backward"),
  input_select_word_forward: keybind("alt+shift+f,alt+shift+right", "keybind.input_select_word_forward"),
  input_select_word_backward: keybind("alt+shift+b,alt+shift+left", "keybind.input_select_word_backward"),
  input_delete_word_forward: keybind("alt+d,alt+delete,ctrl+delete", "keybind.input_delete_word_forward"),
  input_delete_word_backward: keybind("ctrl+w,ctrl+backspace,alt+backspace", "keybind.input_delete_word_backward"),
  input_select_all: keybind("super+a", "keybind.input_select_all"),
  history_previous: keybind("up", "keybind.history_previous"),
  history_next: keybind("down", "keybind.history_next"),

  "dialog.select.prev": keybind("up,ctrl+p", "keybind.dialog.select.prev"),
  "dialog.select.next": keybind("down,ctrl+n", "keybind.dialog.select.next"),
  "dialog.select.page_up": keybind("pageup", "keybind.dialog.select.page_up"),
  "dialog.select.page_down": keybind("pagedown", "keybind.dialog.select.page_down"),
  "dialog.select.home": keybind("home", "keybind.dialog.select.home"),
  "dialog.select.end": keybind("end", "keybind.dialog.select.end"),
  "dialog.select.submit": keybind("return", "keybind.dialog.select.submit"),
  "dialog.prompt.submit": keybind("return", "keybind.dialog.prompt.submit"),
  "dialog.mcp.toggle": keybind("space", "keybind.dialog.mcp.toggle"),
  "dialog.move_session.new": keybind("ctrl+m", "keybind.dialog.move_session.new"),
  "dialog.move_session.delete": keybind("ctrl+d", "keybind.dialog.move_session.delete"),
  "dialog.move_session.refresh": keybind("ctrl+r", "keybind.dialog.move_session.refresh"),
  "prompt.autocomplete.prev": keybind("up,ctrl+p", "keybind.prompt.autocomplete.prev"),
  "prompt.autocomplete.next": keybind("down,ctrl+n", "keybind.prompt.autocomplete.next"),
  "prompt.autocomplete.hide": keybind("escape", "keybind.prompt.autocomplete.hide"),
  "prompt.autocomplete.select": keybind("return", "keybind.prompt.autocomplete.select"),
  "prompt.autocomplete.complete": keybind("tab", "keybind.prompt.autocomplete.complete"),
  "permission.prompt.fullscreen": keybind("ctrl+f", "keybind.permission.prompt.fullscreen"),
  "plugins.toggle": keybind("space", "keybind.plugins.toggle"),
  "dialog.plugins.install": keybind("shift+i", "keybind.dialog.plugins.install"),

  terminal_suspend: keybind("ctrl+z", "keybind.terminal_suspend"),
  terminal_title_toggle: keybind("none", "keybind.terminal_title_toggle"),
  tips_toggle: keybind("<leader>h", "keybind.tips_toggle"),
  plugin_manager: keybind("none", "keybind.plugin_manager"),
  plugin_install: keybind("none", "keybind.plugin_install"),

  which_key_toggle: keybind("ctrl+alt+k", "keybind.which_key_toggle"),
  which_key_layout_toggle: keybind("ctrl+alt+shift+k", "keybind.which_key_layout_toggle"),
  which_key_pending_toggle: keybind("ctrl+alt+shift+p", "keybind.which_key_pending_toggle"),
  which_key_group_previous: keybind("ctrl+alt+left,ctrl+alt+[", "keybind.which_key_group_previous"),
  which_key_group_next: keybind("ctrl+alt+right,ctrl+alt+]", "keybind.which_key_group_next"),
  which_key_scroll_up: keybind("ctrl+alt+up,ctrl+alt+p", "keybind.which_key_scroll_up"),
  which_key_scroll_down: keybind("ctrl+alt+down,ctrl+alt+n", "keybind.which_key_scroll_down"),
  which_key_page_up: keybind("ctrl+alt+pageup", "keybind.which_key_page_up"),
  which_key_page_down: keybind("ctrl+alt+pagedown", "keybind.which_key_page_down"),
  which_key_home: keybind("ctrl+alt+home", "keybind.which_key_home"),
  which_key_end: keybind("ctrl+alt+end", "keybind.which_key_end"),
} satisfies Record<string, Definition>

type KeybindName = keyof typeof Definitions
const KeybindNames = new Set<string>(Object.keys(Definitions))

export const KeybindOverrides = Schema.Struct(
  Object.fromEntries(
    Object.entries(Definitions).map(([name, item]) => [
      name,
      Schema.optional(BindingValueSchema).annotate({ description: item.description }),
    ]),
  ),
).annotate({ description: "TUI keybinding overrides" })
export const Descriptions = Object.fromEntries(
  Object.entries(Definitions).map(([name, item]) => [name, item.description]),
) as Record<KeybindName, string>
export const CommandMap = {
  app_exit: "app.exit",
  app_debug: "app.debug",
  app_console: "app.console",
  app_heap_snapshot: "app.heap_snapshot",
  app_toggle_animations: "app.toggle.animations",
  app_toggle_file_context: "app.toggle.file_context",
  app_toggle_diffwrap: "app.toggle.diffwrap",
  app_toggle_paste_summary: "app.toggle.paste_summary",
  app_toggle_session_directory_filter: "app.toggle.session_directory_filter",
  command_list: "command.palette.show",
  help_show: "help.show",
  docs_open: "docs.open",
  diff_open: "diff.open",
  diff_close: "diff.close",
  diff_toggle: "diff.toggle",
  diff_expand: "diff.expand",
  diff_expand_all: "diff.expand_all",
  diff_collapse: "diff.collapse",
  diff_switch_focus: "diff.switch_focus",
  diff_next_hunk: "diff.next_hunk",
  diff_previous_hunk: "diff.previous_hunk",
  diff_next_file: "diff.next_file",
  diff_previous_file: "diff.previous_file",
  diff_toggle_file_tree: "diff.toggle_file_tree",
  diff_single_patch: "diff.single_patch",
  diff_switch_source: "diff.switch_source",
  diff_toggle_view: "diff.toggle_view",
  diff_help: "diff.help",
  editor_open: "prompt.editor",
  language_switch: "language.switch",
  theme_list: "theme.switch",
  theme_switch_mode: "theme.switch_mode",
  theme_mode_lock: "theme.mode.lock",
  sidebar_toggle: "session.sidebar.toggle",
  scrollbar_toggle: "session.toggle.scrollbar",
  status_view: "redrob.status",
  debug_view: "redrob.debug",
  session_export: "session.export",
  session_copy: "session.copy",
  session_move: "session.move",
  session_new: "session.new",
  session_list: "session.list",
  session_timeline: "session.timeline",
  session_fork: "session.fork",
  session_rename: "session.rename",
  session_delete: "session.delete",
  session_share: "session.share",
  session_unshare: "session.unshare",
  session_interrupt: "session.interrupt",
  session_background: "session.background",
  session_compact: "session.compact",
  session_toggle_timestamps: "session.toggle.timestamps",
  session_toggle_generic_tool_output: "session.toggle.generic_tool_output",
  session_queued_prompts: "session.queued_prompts",
  session_child_first: "session.child.first",
  session_child_cycle: "session.child.next",
  session_child_cycle_reverse: "session.child.previous",
  session_parent: "session.parent",
  session_pin_toggle: "session.pin.toggle",
  session_quick_switch_1: "session.quick_switch.1",
  session_quick_switch_2: "session.quick_switch.2",
  session_quick_switch_3: "session.quick_switch.3",
  session_quick_switch_4: "session.quick_switch.4",
  session_quick_switch_5: "session.quick_switch.5",
  session_quick_switch_6: "session.quick_switch.6",
  session_quick_switch_7: "session.quick_switch.7",
  session_quick_switch_8: "session.quick_switch.8",
  session_quick_switch_9: "session.quick_switch.9",
  stash_delete: "stash.delete",
  model_provider_list: "model.dialog.provider",
  model_favorite_toggle: "model.dialog.favorite",
  model_list: "model.list",
  model_cycle_recent: "model.cycle_recent",
  model_cycle_recent_reverse: "model.cycle_recent_reverse",
  model_cycle_favorite: "model.cycle_favorite",
  model_cycle_favorite_reverse: "model.cycle_favorite_reverse",
  mcp_list: "mcp.list",
  provider_connect: "provider.connect",
  console_org_switch: "console.org.switch",
  agent_list: "agent.list",
  agent_cycle: "agent.cycle",
  agent_cycle_reverse: "agent.cycle.reverse",
  variant_cycle: "variant.cycle",
  variant_list: "variant.list",
  messages_page_up: "session.page.up",
  messages_page_down: "session.page.down",
  messages_line_up: "session.line.up",
  messages_line_down: "session.line.down",
  messages_half_page_up: "session.half.page.up",
  messages_half_page_down: "session.half.page.down",
  messages_first: "session.first",
  messages_last: "session.last",
  messages_next: "session.message.next",
  messages_previous: "session.message.previous",
  messages_last_user: "session.messages_last_user",
  messages_copy: "messages.copy",
  messages_undo: "session.undo",
  messages_redo: "session.redo",
  messages_toggle_conceal: "session.toggle.conceal",
  tool_details: "session.toggle.actions",
  display_thinking: "session.toggle.thinking",
  prompt_submit: "prompt.submit",
  prompt_editor_context_clear: "prompt.editor_context.clear",
  prompt_skills: "prompt.skills",
  prompt_stash: "prompt.stash",
  prompt_stash_pop: "prompt.stash.pop",
  prompt_stash_list: "prompt.stash.list",
  workspace_set: "workspace.set",
  input_clear: "prompt.clear",
  input_paste: "prompt.paste",
  input_submit: "input.submit",
  input_newline: "input.newline",
  input_move_left: "input.move.left",
  input_move_right: "input.move.right",
  input_move_up: "input.move.up",
  input_move_down: "input.move.down",
  input_select_left: "input.select.left",
  input_select_right: "input.select.right",
  input_select_up: "input.select.up",
  input_select_down: "input.select.down",
  input_line_home: "input.line.home",
  input_line_end: "input.line.end",
  input_select_line_home: "input.select.line.home",
  input_select_line_end: "input.select.line.end",
  input_visual_line_home: "input.visual.line.home",
  input_visual_line_end: "input.visual.line.end",
  input_select_visual_line_home: "input.select.visual.line.home",
  input_select_visual_line_end: "input.select.visual.line.end",
  input_buffer_home: "input.buffer.home",
  input_buffer_end: "input.buffer.end",
  input_select_buffer_home: "input.select.buffer.home",
  input_select_buffer_end: "input.select.buffer.end",
  input_delete_line: "input.delete.line",
  input_delete_to_line_end: "input.delete.to.line.end",
  input_delete_to_line_start: "input.delete.to.line.start",
  input_backspace: "input.backspace",
  input_delete: "input.delete",
  input_undo: "input.undo",
  input_redo: "input.redo",
  input_word_forward: "input.word.forward",
  input_word_backward: "input.word.backward",
  input_select_word_forward: "input.select.word.forward",
  input_select_word_backward: "input.select.word.backward",
  input_delete_word_forward: "input.delete.word.forward",
  input_delete_word_backward: "input.delete.word.backward",
  input_select_all: "input.select.all",
  history_previous: "prompt.history.previous",
  history_next: "prompt.history.next",
  terminal_suspend: "terminal.suspend",
  terminal_title_toggle: "terminal.title.toggle",
  tips_toggle: "tips.toggle",
  plugin_manager: "plugins.list",
  plugin_install: "plugins.install",
  which_key_toggle: "which-key.toggle",
  which_key_layout_toggle: "which-key.layout.toggle",
  which_key_pending_toggle: "which-key.pending.toggle",
  which_key_group_previous: "which-key.group.previous",
  which_key_group_next: "which-key.group.next",
  which_key_scroll_up: "which-key.scroll.up",
  which_key_scroll_down: "which-key.scroll.down",
  which_key_page_up: "which-key.page.up",
  which_key_page_down: "which-key.page.down",
  which_key_home: "which-key.home",
  which_key_end: "which-key.end",
} satisfies BindingCommandMap
const CommandDescriptions = Object.fromEntries(
  Object.entries(Definitions).map(([name, item]) => [
    CommandMap[name as keyof typeof CommandMap] ?? name,
    item.description,
  ]),
) as Record<string, string>
// Command name → dictionary key, so anything rendering a default binding description can
// translate it instead of reading the English `desc` baked in at config resolve time.
export const CommandDescriptionKeys = Object.fromEntries(
  Object.entries(Definitions).map(([name, item]) => [CommandMap[name as keyof typeof CommandMap] ?? name, item.key]),
) as Record<string, TuiI18nKey>

export type Keybinds = { [K in KeybindName]: BindingValueSchema }
export type KeybindOverrides = Partial<Keybinds>
export type BindingLookupView = {
  readonly bindings: readonly Binding<Renderable, KeyEvent>[]
  get(command: string): readonly Binding<Renderable, KeyEvent>[]
  has(command: string): boolean
  gather(name: string, commands: readonly string[]): readonly Binding<Renderable, KeyEvent>[]
  pick(name: string, commands: readonly string[]): Binding<Renderable, KeyEvent>[]
  omit(name: string, commands: readonly string[]): Binding<Renderable, KeyEvent>[]
}

export function toBindingConfig(keybinds: Keybinds): BindingConfig<Renderable, KeyEvent> {
  return Object.fromEntries(Object.entries(keybinds)) as BindingConfig<Renderable, KeyEvent>
}

const decodeBindingValue = Schema.decodeUnknownSync(BindingValueSchema)

export function defaultValue(name: KeybindName) {
  return Definitions[name].default
}

export function parse(keybinds: KeybindOverrides): Keybinds {
  const invalid = unknownKeys(keybinds)
  if (invalid.length) throw new Error(`Unrecognized keybind${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}`)
  return Object.fromEntries(
    Object.entries(Definitions).map(([name, item]) => [
      name,
      decodeBindingValue(keybinds[name as KeybindName] ?? item.default),
    ]),
  ) as Keybinds
}

export const Keybinds = { parse }

export function unknownKeys(input: object) {
  return Object.keys(input).filter((key) => !KeybindNames.has(key))
}

export function bindingDefaults(): BindingDefaults<Renderable, KeyEvent> {
  return ({ command, binding }) => {
    if (binding.desc !== undefined) return
    return { desc: CommandDescriptions[command] }
  }
}
