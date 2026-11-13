import type { TuiPlugin, TuiPluginApi } from "@redrob-code/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show } from "solid-js"
import { TodoItem } from "../../component/todo-item"
import { useLanguage } from "../../context/language"

const id = "internal:sidebar-todo"
// Remembered in kv.json so a folded list stays folded across sessions and restarts.
export const TODO_OPEN = "sidebar_todo_open"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const language = useLanguage()
  const open = () => props.api.kv.get(TODO_OPEN, true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.todo(props.session_id))
  const show = createMemo(() => list().length > 0 && list().some((item) => item.status !== "completed"))

  return (
    <Show when={show()}>
      <box>
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => list().length > 2 && props.api.kv.set(TODO_OPEN, !open())}
        >
          <Show when={list().length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>{language.t("sidebar.todo")}</b>
          </text>
        </box>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>{(item) => <TodoItem status={item.status} content={item.content} />}</For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 400,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
