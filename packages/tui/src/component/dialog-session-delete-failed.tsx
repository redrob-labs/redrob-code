import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { useBindings } from "../keymap"
import { useLanguage } from "../context/language"

export function DialogSessionDeleteFailed(props: {
  session: string
  workspace: string
  onDelete?: () => boolean | void | Promise<boolean | void>
  onRestore?: () => boolean | void | Promise<boolean | void>
  onDone?: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const language = useLanguage()
  const [store, setStore] = createStore({
    active: "delete" as "delete" | "restore",
  })

  const options = [
    {
      id: "delete" as const,
      title: language.t("session.delete_failed.delete_workspace"),
      description: language.t("session.delete_failed.delete_workspace.desc"),
      run: props.onDelete,
    },
    {
      id: "restore" as const,
      title: language.t("session.delete_failed.restore"),
      description: language.t("session.delete_failed.restore.desc"),
      run: props.onRestore,
    },
  ]

  async function confirm() {
    const result = await options.find((item) => item.id === store.active)?.run?.()
    if (result === false) return
    props.onDone?.()
    if (!props.onDone) dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        desc: language.t("session.delete_failed.binding.confirm"),
        group: "Dialog",
        cmd: () => void confirm(),
      },
      {
        key: "left",
        desc: language.t("session.delete_failed.binding.delete"),
        group: "Dialog",
        cmd: () => setStore("active", "delete"),
      },
      {
        key: "up",
        desc: language.t("session.delete_failed.binding.delete"),
        group: "Dialog",
        cmd: () => setStore("active", "delete"),
      },
      {
        key: "right",
        desc: language.t("session.delete_failed.binding.restore"),
        group: "Dialog",
        cmd: () => setStore("active", "restore"),
      },
      {
        key: "down",
        desc: language.t("session.delete_failed.binding.restore"),
        group: "Dialog",
        cmd: () => setStore("active", "restore"),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {language.t("session.delete_failed.title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          {language.t("dialog.esc")}
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word">
        {language.t("session.delete_failed.body", { session: props.session, workspace: props.workspace })}
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        {language.t("session.delete_failed.choose")}
      </text>
      <box flexDirection="column" paddingBottom={1} gap={1}>
        <For each={options}>
          {(item) => (
            <box
              flexDirection="column"
              paddingLeft={1}
              paddingRight={1}
              paddingTop={1}
              paddingBottom={1}
              backgroundColor={item.id === store.active ? theme.primary : undefined}
              onMouseUp={() => {
                setStore("active", item.id)
                void confirm()
              }}
            >
              <text
                attributes={TextAttributes.BOLD}
                fg={item.id === store.active ? theme.selectedListItemText : theme.text}
              >
                {item.title}
              </text>
              <text fg={item.id === store.active ? theme.selectedListItemText : theme.textMuted} wrapMode="word">
                {item.description}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}
