import type { TuiPlugin, TuiPluginApi, TuiPluginStatus } from "@redrob-code/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { useTerminalDimensions } from "@opentui/solid"
import { fileURLToPath } from "url"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { Show, createEffect, createMemo, createSignal } from "solid-js"
import { useBindings } from "../../keymap"
import { useLanguage, type LanguageContext } from "../../context/language"
import { kvTranslator } from "../../i18n"

const id = "internal:plugin-manager"

function state(api: TuiPluginApi, item: TuiPluginStatus) {
  const language = useLanguage()
  if (!item.enabled) {
    return <span style={{ fg: api.theme.current.textMuted }}>{language.t("plugins.state.disabled")}</span>
  }

  return (
    <span style={{ fg: item.active ? api.theme.current.success : api.theme.current.error }}>
      {item.active ? language.t("plugins.state.active") : language.t("plugins.state.inactive")}
    </span>
  )
}

function source(spec: string) {
  if (!spec.startsWith("file://")) return
  return fileURLToPath(spec)
}

function meta(language: LanguageContext, item: TuiPluginStatus, width: number) {
  if (item.source === "internal") {
    if (width >= 120) return language.t("plugins.source.builtin")
    return language.t("plugins.source.builtin.short")
  }
  const next = source(item.spec)
  if (next) return next
  return item.spec
}

function Install(props: { api: TuiPluginApi }) {
  const language = useLanguage()
  const [global, setGlobal] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const scope = () => (global() ? language.t("plugins.scope.global") : language.t("plugins.scope.local"))

  useBindings(() => ({
    enabled: !busy(),
    bindings: [
      {
        key: "tab",
        desc: language.t("plugins.install.binding.scope"),
        group: "Plugins",
        cmd: () => setGlobal((value) => !value),
      },
    ],
  }))

  return (
    <props.api.ui.DialogPrompt
      title={language.t("plugins.install.title")}
      placeholder={language.t("plugins.install.placeholder")}
      busy={busy()}
      busyText={language.t("plugins.install.busy")}
      description={() => (
        <box flexDirection="row" gap={1}>
          <text fg={props.api.theme.current.textMuted}>{language.t("plugins.install.scope")}</text>
          <text fg={busy() ? props.api.theme.current.textMuted : props.api.theme.current.text}>{scope()}</text>
          <Show when={!busy()}>
            <text fg={props.api.theme.current.textMuted}>{language.t("plugins.install.scope_hint")}</text>
          </Show>
        </box>
      )}
      onConfirm={(raw) => {
        if (busy()) return
        const mod = raw.trim()
        if (!mod) {
          props.api.ui.toast({
            variant: "error",
            message: language.t("plugins.install.name_required"),
          })
          return
        }

        setBusy(true)
        void props.api.plugins
          .install(mod, { global: global() })
          .then((out) => {
            if (!out.ok) {
              props.api.ui.toast({
                variant: "error",
                message: out.message,
              })
              if (out.missing) {
                props.api.ui.toast({
                  variant: "info",
                  message: language.t("plugins.install.missing"),
                })
              }
              show(props.api)
              return
            }

            props.api.ui.toast({
              variant: "success",
              message: language.t("plugins.install.done", { module: mod, scope: scope(), dir: out.dir }),
            })
            if (!out.tui) {
              props.api.ui.toast({
                variant: "info",
                message: language.t("plugins.install.no_tui"),
              })
              show(props.api)
              return
            }

            return props.api.plugins.add(mod).then((ok) => {
              if (!ok) {
                props.api.ui.toast({
                  variant: "warning",
                  message: language.t("plugins.install.load_failed"),
                })
                show(props.api)
                return
              }

              props.api.ui.toast({
                variant: "success",
                message: language.t("plugins.install.loaded", { module: mod }),
              })
              show(props.api)
            })
          })
          .finally(() => {
            setBusy(false)
          })
      }}
      onCancel={() => {
        show(props.api)
      }}
    />
  )
}

function row(
  api: TuiPluginApi,
  language: LanguageContext,
  item: TuiPluginStatus,
  width: number,
): DialogSelectOption<string> {
  return {
    title: item.id,
    value: item.id,
    category: language.category(item.source === "internal" ? "Internal" : "External"),
    description: meta(language, item, width),
    footer: state(api, item),
    disabled: item.id === id,
  }
}

function showInstall(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <Install api={api} />)
}

function View(props: { api: TuiPluginApi }) {
  const language = useLanguage()
  const size = useTerminalDimensions()
  const [list, setList] = createSignal(props.api.plugins.list())
  const [cur, setCur] = createSignal<string | undefined>()
  const [lock, setLock] = createSignal(false)

  createEffect(() => {
    const width = size().width
    if (width >= 128) {
      props.api.ui.dialog.setSize("xlarge")
      return
    }
    if (width >= 96) {
      props.api.ui.dialog.setSize("large")
      return
    }
    props.api.ui.dialog.setSize("medium")
  })

  const rows = createMemo(() =>
    [...list()]
      .sort((a, b) => {
        const x = a.source === "internal" ? 1 : 0
        const y = b.source === "internal" ? 1 : 0
        if (x !== y) return x - y
        return a.id.localeCompare(b.id)
      })
      .map((item) => row(props.api, language, item, size().width)),
  )

  const flip = (x: string) => {
    if (lock()) return
    const item = list().find((entry) => entry.id === x)
    if (!item) return
    setLock(true)
    const task = item.active ? props.api.plugins.deactivate(x) : props.api.plugins.activate(x)
    void task
      .then((ok) => {
        if (!ok) {
          props.api.ui.toast({
            variant: "error",
            message: language.t("plugins.toggle_failed", { plugin: item.id }),
          })
        }
        setList(props.api.plugins.list())
      })
      .finally(() => {
        setLock(false)
      })
  }

  return (
    <DialogSelect
      title={language.t("plugins.dialog.title")}
      options={rows()}
      current={cur()}
      onMove={(item) => setCur(item.value)}
      actions={[
        {
          title: language.t("action.toggle"),
          command: "plugins.toggle",
          hidden: lock(),
          onTrigger: (item) => {
            setCur(item.value)
            flip(item.value)
          },
        },
        {
          title: language.t("action.install"),
          command: "dialog.plugins.install",
          hidden: lock(),
          onTrigger: () => {
            showInstall(props.api)
          },
        },
      ]}
      onSelect={(item) => {
        setCur(item.value)
        flip(item.value)
      }}
    />
  )
}

function show(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <View api={api} />)
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "plugins.list",
        // Registered at plugin bootstrap, so the title resolves the persisted locale on read.
        get title() {
          return kvTranslator(api.kv).t("plugins.dialog.title")
        },
        category: "System",
        namespace: "palette",
        run() {
          show(api)
        },
      },
      {
        name: "plugins.install",
        get title() {
          return kvTranslator(api.kv).t("plugins.install.title")
        },
        category: "System",
        namespace: "palette",
        run() {
          showInstall(api)
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("plugins.palette", ["plugins.list", "plugins.install"]),
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
