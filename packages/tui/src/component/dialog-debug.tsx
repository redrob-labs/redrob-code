import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For } from "solid-js"
import { InstallationChannel, InstallationVersion } from "@redrob-code/core/installation/version"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useRoute } from "../context/route"
import { useLocal } from "../context/local"
import { useClipboard } from "../context/clipboard"
import { useToast } from "../ui/toast"
import { useBindings } from "../keymap"
import { describeOS, describeTerminal } from "../util/system"
import { useLanguage } from "../context/language"

export function DialogDebug() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const language = useLanguage()
  const route = useRoute()
  const local = useLocal()
  const clipboard = useClipboard()
  const toast = useToast()
  const [copied, setCopied] = createSignal(false)

  dialog.setSize("large")

  const entries = createMemo(() => {
    const model = local.model.current()
    const none = language.t("debug.value.none")
    return [
      { label: language.t("debug.label.version"), value: `${InstallationVersion} (${InstallationChannel})` },
      { label: language.t("debug.label.date"), value: new Date().toISOString() },
      { label: language.t("debug.label.os"), value: describeOS() },
      { label: language.t("debug.label.terminal"), value: describeTerminal() },
      {
        label: language.t("debug.label.session"),
        value: route.data.type === "session" ? route.data.sessionID : none,
      },
      { label: language.t("debug.label.model"), value: model ? `${model.providerID}/${model.modelID}` : none },
    ]
  })

  const copy = () => {
    const text = entries()
      .map((entry) => `${entry.label}: ${entry.value}`)
      .join("\n")
    void clipboard
      .write?.(text)
      .then(() => {
        setCopied(true)
        toast.show({ message: language.t("debug.copied"), variant: "info" })
      })
      .catch(toast.error)
  }

  useBindings(() => ({
    bindings: [{ key: "return", desc: language.t("debug.binding.copy"), group: "Dialog", cmd: copy }],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {language.t("debug.title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          {language.t("dialog.esc")}
        </text>
      </box>
      {/* No click-to-copy here: releasing a mouse selection must trigger the
          global copy-on-select so users can copy a single value, e.g. the session id. */}
      <box>
        <For each={entries()}>
          {(entry) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={theme.textMuted}>
                {entry.label.padEnd(10)}
              </text>
              <text fg={theme.text} wrapMode="word">
                {entry.value}
              </text>
            </box>
          )}
        </For>
      </box>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.textMuted}>{language.t("debug.footer")}</text>
        <text onMouseUp={copy}>
          <span style={{ fg: copied() ? theme.success : theme.text }}>
            <b>{copied() ? language.t("debug.action.copied") : language.t("debug.action.copy")}</b>{" "}
          </span>
          <span style={{ fg: theme.textMuted }}>{language.t("debug.hint.enter")}</span>
        </text>
      </box>
    </box>
  )
}
