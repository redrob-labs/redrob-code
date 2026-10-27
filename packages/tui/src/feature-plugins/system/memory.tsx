import type { TuiPlugin, TuiPluginApi } from "@redrob-code/plugin/tui"
import type { MemoryEntry } from "@redrob-labs/sdk/v2"
import type { BuiltinTuiPlugin } from "../builtins"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { createMemo, createResource, createSignal } from "solid-js"
import { useLanguage } from "../../context/language"
import { kvTranslator } from "../../i18n"

const id = "internal:memory"

function text(entry: MemoryEntry) {
  if (entry.kind === "fact") return `${entry.key ?? ""} = ${entry.text}`
  return entry.negative ? `${entry.text} (NOT: ${entry.negative})` : entry.text
}

function View(props: { api: TuiPluginApi }) {
  const language = useLanguage()
  const [cur, setCur] = createSignal<string | undefined>()
  const [busy, setBusy] = createSignal(false)
  const [entries, { refetch }] = createResource(async () => {
    const result = await props.api.client.memory.list({}, { throwOnError: true })
    return result.data ?? []
  })

  props.api.ui.dialog.setSize("large")

  const rows = createMemo((): DialogSelectOption<string>[] =>
    (entries() ?? []).map((entry) => ({
      title: text(entry),
      value: entry.id,
      category: language.t(entry.kind === "lesson" ? "memory.category.lessons" : "memory.category.facts"),
      description: entry.project ?? language.t("memory.scope.global"),
    })),
  )

  const remove = (value: string) => {
    if (busy()) return
    setBusy(true)
    void props.api.client.memory
      .remove({ id: value }, { throwOnError: true })
      .then(() => {
        props.api.ui.toast({ variant: "success", message: language.t("memory.removed") })
        return refetch()
      })
      .catch(() => {
        props.api.ui.toast({ variant: "error", message: language.t("memory.remove_failed") })
      })
      .finally(() => setBusy(false))
  }

  return (
    <DialogSelect
      title={language.t("memory.dialog.title")}
      placeholder={entries.loading ? language.t("memory.loading") : undefined}
      options={rows()}
      current={cur()}
      onMove={(item) => setCur(item.value)}
      actions={[
        {
          title: language.t("action.delete"),
          // Borrows the ctrl+d delete binding the move-session dialog already declares, so this
          // dialog adds no keybind config of its own.
          command: "dialog.move_session.delete",
          hidden: busy(),
          onTrigger: (item) => remove(item.value),
        },
      ]}
      onSelect={(item) => setCur(item.value)}
    />
  )
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "memory.list",
        // Registered at plugin bootstrap, so the title resolves the persisted locale on read.
        get title() {
          return kvTranslator(api.kv).t("memory.dialog.title")
        },
        category: "System",
        namespace: "palette",
        run() {
          api.ui.dialog.replace(() => <View api={api} />)
        },
      },
    ],
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
