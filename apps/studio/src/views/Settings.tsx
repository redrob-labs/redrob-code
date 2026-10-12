import { useEffect, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Alert, Button, Card, Switch, ThemeSwitch } from "@redrob-labs/ui"
import type { AppInfo, EngineState, Settings, UpdaterState } from "@redrob-code/desktop/bridge"
import { useEngine } from "../engine"
import { useT, type Translate } from "../i18n"

export function SettingsPanel(props: {
  settings: Settings
  engineState: EngineState
  appInfo: AppInfo | null
  onChange: (patch: Partial<Settings>) => Promise<void>
  onClose: () => void
}) {
  const t = useT()
  const bridge = window.redrobCode!
  const { info } = useEngine()
  const [updater, setUpdater] = useState<UpdaterState>({ status: "idle" })
  const [confirmInstall, setConfirmInstall] = useState(false)
  useEffect(() => bridge.updater.onState(setUpdater), [bridge])

  const cli = useQuery({ queryKey: ["cli"], queryFn: () => bridge.cli.status() })
  const install = useMutation({ mutationFn: () => bridge.cli.install(), onSettled: () => void cli.refetch() })
  const { settings } = props

  return (
    <div className="rc-settings rc-stack">
      <div className="rc-row rc-between">
        <h2>{t("settings.title")}</h2>
        <Button variant="ghost" onClick={props.onClose}>
          {t("settings.close")}
        </Button>
      </div>

      <Card title={t("settings.language")}>
        <div className="rc-row">
          {(["en", "ko"] as const).map((language) => (
            <Button
              key={language}
              size="sm"
              variant={settings.language === language ? "primary" : "secondary"}
              onClick={() => void props.onChange({ language })}
            >
              {language === "en" ? "English" : "한국어"}
            </Button>
          ))}
        </div>
      </Card>

      <Card title={t("settings.theme")}>
        <ThemeSwitch value={settings.theme} target={null} onChange={(theme) => void props.onChange({ theme })} />
      </Card>

      <Card title={t("settings.updates")} meta={props.appInfo ? `v${props.appInfo.version}` : undefined}>
        <div className="rc-stack">
          <div className="rc-row">
            {(["stable", "alpha"] as const).map((channel) => (
              <Button
                key={channel}
                size="sm"
                variant={settings.updateChannel === channel ? "primary" : "secondary"}
                onClick={() => void props.onChange({ updateChannel: channel })}
              >
                {t(channel === "stable" ? "settings.channel.stable" : "settings.channel.alpha")}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => void bridge.updater.check()}>
              {t("settings.checkUpdates")}
            </Button>
            {updater.status === "ready" && (
              <Button size="sm" variant="primary" onClick={() => void bridge.updater.install()}>
                {t("settings.installUpdate")}
              </Button>
            )}
          </div>
          <UpdaterLine state={updater} t={t} />
        </div>
      </Card>

      <Card title={t("settings.cli")}>
        <div className="rc-stack">
          <p className="rc-muted">
            {cli.data?.installed
              ? t("settings.cli.installed", { path: cli.data.path ?? "", version: cli.data.version ?? "?" })
              : t("settings.cli.missing")}
          </p>
          {cli.data && !cli.data.installed && !confirmInstall && (
            <Button size="sm" variant="secondary" onClick={() => setConfirmInstall(true)}>
              {t("settings.cli.install")}
            </Button>
          )}
          {cli.data && confirmInstall && !cli.data.installed && (
            <Alert
              tone="info"
              title={t("settings.cli.confirm")}
              action={
                <Button size="sm" variant="primary" loading={install.isPending} onClick={() => install.mutate()}>
                  {t("settings.cli.install")}
                </Button>
              }
            >
              <code>{cli.data.installCommand}</code>
            </Alert>
          )}
          {install.data && <pre className="rc-log">{install.data.output}</pre>}
          <Switch
            label={t("settings.cli.prefer")}
            checked={settings.preferInstalledCli}
            onChange={(event) => void props.onChange({ preferInstalledCli: event.target.checked })}
          />
        </div>
      </Card>

      <Card title={t("settings.privacy")} description={t("consent.body")}>
        <div className="rc-stack">
          <Switch
            label={t("consent.crash")}
            checked={settings.consent.crashReports}
            onChange={(event) =>
              void props.onChange({ consent: { ...settings.consent, crashReports: event.target.checked } })
            }
          />
          <Switch
            label={t("consent.usage")}
            checked={settings.consent.usageEvents}
            onChange={(event) =>
              void props.onChange({ consent: { ...settings.consent, usageEvents: event.target.checked } })
            }
          />
        </div>
      </Card>

      <Card
        title={t("settings.engine")}
        meta={
          props.engineState.status === "ready" && props.engineState.version
            ? `v${props.engineState.version}`
            : undefined
        }
      >
        <div className="rc-stack">
          <p className="rc-muted">
            {t(`engine.source.${info.source}` as const)} · <code>{info.binary}</code>
          </p>
          <Button size="sm" variant="secondary" onClick={() => void bridge.engine.restart()}>
            {t("engine.restart")}
          </Button>
        </div>
      </Card>
    </div>
  )
}

function UpdaterLine(props: { state: UpdaterState; t: Translate }) {
  const { state, t } = props
  switch (state.status) {
    case "checking":
      return <p className="rc-muted">{t("update.checking")}</p>
    case "available":
      return <p className="rc-muted">{t("update.available", { version: state.version })}</p>
    case "downloading":
      return <p className="rc-muted">{state.percent}%</p>
    case "ready":
      return <p className="rc-muted">{t("update.ready", { version: state.version })}</p>
    case "none":
      return <p className="rc-muted">{t("update.none")}</p>
    case "unsupported":
      return <p className="rc-muted">{state.reason}</p>
    case "error":
      return <p className="rc-danger">{t("update.error", { message: state.message })}</p>
    default:
      return null
  }
}
