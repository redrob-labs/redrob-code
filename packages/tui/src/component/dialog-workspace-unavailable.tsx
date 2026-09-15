import { TextAttributes } from "@opentui/core"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useBindings } from "../keymap"
import { useLanguage } from "../context/language"

export function DialogWorkspaceUnavailable(props: { onRestore?: () => boolean | void | Promise<boolean | void> }) {
  const dialog = useDialog()
  const language = useLanguage()
  const { theme } = useTheme()
  const [store, setStore] = createStore({
    active: "restore" as "cancel" | "restore",
  })

  const options = ["cancel", "restore"] as const

  async function confirm() {
    if (store.active === "cancel") {
      dialog.clear()
      return
    }
    const result = await props.onRestore?.()
    if (result === false) return
  }

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        desc: language.t("workspace.unavailable.binding.confirm"),
        group: "Dialog",
        cmd: () => void confirm(),
      },
      {
        key: "left",
        desc: language.t("workspace.unavailable.binding.cancel"),
        group: "Dialog",
        cmd: () => setStore("active", "cancel"),
      },
      {
        key: "right",
        desc: language.t("workspace.unavailable.binding.restore"),
        group: "Dialog",
        cmd: () => setStore("active", "restore"),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {language.t("workspace.unavailable.title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          {language.t("dialog.esc")}
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word">
        {language.t("workspace.unavailable.body")}
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        {language.t("workspace.unavailable.question")}
      </text>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1} gap={1}>
        <For each={options}>
          {(item) => (
            <box
              paddingLeft={2}
              paddingRight={2}
              backgroundColor={item === store.active ? theme.primary : undefined}
              onMouseUp={() => {
                setStore("active", item)
                void confirm()
              }}
            >
              <text fg={item === store.active ? theme.selectedListItemText : theme.textMuted}>
                {language.t(`workspace.unavailable.${item}`)}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}
