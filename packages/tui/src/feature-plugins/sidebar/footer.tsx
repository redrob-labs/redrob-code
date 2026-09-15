import type { TuiPlugin, TuiPluginApi } from "@redrob-code/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"
import { abbreviateHome } from "../../runtime"
import { useTuiPaths } from "../../context/runtime"
import { useLanguage } from "../../context/language"

const id = "internal:sidebar-footer"

function View(props: { api: TuiPluginApi; sessionID: string }) {
  const paths = useTuiPaths()
  const language = useLanguage()
  const theme = () => props.api.theme.current
  const has = createMemo(() =>
    props.api.state.provider.some(
      (item) => item.id !== "redrob" || Object.values(item.models).some((model) => model.cost?.input !== 0),
    ),
  )
  const done = createMemo(() => props.api.kv.get("dismissed_getting_started", false))
  const show = createMemo(() => !has() && !done())
  // A source build reports `local` instead of a semver string, so label it as such.
  const version = createMemo(() =>
    props.api.app.version === "local" ? language.t("app.version.local") : props.api.app.version,
  )
  const path = createMemo(() => {
    const session = props.api.state.session.get(props.sessionID)
    const dir = session?.directory || props.api.state.path.directory || paths.cwd
    const out = abbreviateHome(dir, paths.home)
    const branch = session?.directory === props.api.state.path.directory ? props.api.state.vcs?.branch : undefined
    const text = branch ? out + ":" + branch : out
    const list = text.split("/")
    return {
      parent: list.slice(0, -1).join("/"),
      name: list.at(-1) ?? "",
    }
  })

  return (
    <box gap={1}>
      <Show when={show()}>
        <box
          backgroundColor={theme().backgroundElement}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          flexDirection="row"
          gap={1}
        >
          <text flexShrink={0} fg={theme().text}>
            ⬖
          </text>
          <box flexGrow={1} gap={1}>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().text}>
                <b>{language.t("home.getting_started.title")}</b>
              </text>
              <text fg={theme().textMuted} onMouseDown={() => props.api.kv.set("dismissed_getting_started", true)}>
                ✕
              </text>
            </box>
            <text fg={theme().textMuted}>{language.t("home.getting_started.body")}</text>
            <text fg={theme().textMuted}>{language.t("home.getting_started.providers")}</text>
            <box flexDirection="row" gap={1} justifyContent="space-between">
              <text fg={theme().text}>{language.t("home.getting_started.action")}</text>
              <text fg={theme().textMuted}>/connect</text>
            </box>
          </box>
        </box>
      </Show>
      <text>
        <span style={{ fg: theme().textMuted }}>{path().parent}/</span>
        <span style={{ fg: theme().text }}>{path().name}</span>
      </text>
      <text fg={theme().textMuted}>
        <span style={{ fg: theme().success }}>•</span> <b>{language.t("app.name.first")}</b>{" "}
        <span style={{ fg: theme().text }}>
          <b>{language.t("app.name.second")}</b>
        </span>{" "}
        <span>{version()}</span>
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_footer(_ctx, props) {
        return <View api={api} sessionID={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
