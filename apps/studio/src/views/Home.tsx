import { useCallback, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AppShell, Badge, Button, EmptyState } from "@redrob-labs/ui"
import type { AppInfo, EngineState, Settings as SettingsValue } from "@redrob-code/desktop/bridge"
import { useEngine, useEngineEvents } from "../engine"
import { useT } from "../i18n"
import { SettingsPanel } from "./Settings"
import { SignIn } from "./SignIn"
import { Workspace } from "./Workspace"

function folderName(directory: string) {
  return directory.split(/[\\/]/).filter(Boolean).pop() ?? directory
}

export function Home(props: {
  settings: SettingsValue
  appInfo: AppInfo | null
  engineState: EngineState
  onSettings: (patch: Partial<SettingsValue>) => Promise<void>
}) {
  const t = useT()
  const bridge = window.redrobCode!
  const { client } = useEngine()
  const queries = useQueryClient()
  const [project, setProject] = useState<string | null>(props.settings.recentProjects[0] ?? null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [skipSignIn, setSkipSignIn] = useState(false)

  const redrob = useQuery({
    queryKey: ["integration", "redrob"],
    queryFn: () => client.integrations.get({ integrationID: "redrob" }),
  })
  const signedIn = (redrob.data?.data?.connections.length ?? 0) > 0
  useEngineEvents((event) => {
    if (event.type === "integration.connection.updated" || event.type === "integration.updated")
      void queries.invalidateQueries({ queryKey: ["integration"] })
  })
  const refreshSignIn = useCallback(() => void queries.invalidateQueries({ queryKey: ["integration"] }), [queries])

  const open = async (directory: string) => {
    setProject(directory)
    const recent = [directory, ...props.settings.recentProjects.filter((item) => item !== directory)]
    await props.onSettings({ recentProjects: recent })
  }

  const pick = async () => {
    const directory = await bridge.pickDirectory()
    if (directory) await open(directory)
  }

  const windows = props.appInfo?.platform === "windows"

  return (
    <AppShell
      product="Code"
      dragRegion
      windowInset={
        windows ? { end: 144, endHeight: 40 } : props.appInfo?.platform === "macos" ? { top: 28 } : undefined
      }
      title={project ? folderName(project) : t("projects.title")}
      meta={project ?? undefined}
      measure={false}
      actions={
        <div className="rc-row">
          {redrob.isSuccess && (
            <Badge tone={signedIn ? "success" : "warning"} dot>
              {signedIn ? t("account.signedIn") : t("account.signedOut")}
            </Badge>
          )}
          <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>
            {t("settings.title")}
          </Button>
        </div>
      }
      aside={
        <nav className="rc-aside" aria-label={t("projects.title")}>
          <Button variant="secondary" size="sm" fullWidth onClick={() => void pick()}>
            {t("projects.open")}
          </Button>
          {props.settings.recentProjects.length > 0 && <p className="rc-label">{t("projects.recent")}</p>}
          <ul className="rc-list">
            {props.settings.recentProjects.map((directory) => (
              <li key={directory}>
                <button
                  type="button"
                  className="rc-list__item"
                  aria-current={directory === project ? "page" : undefined}
                  title={directory}
                  onClick={() => void open(directory)}
                >
                  {folderName(directory)}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      }
    >
      {settingsOpen ? (
        <SettingsPanel
          settings={props.settings}
          engineState={props.engineState}
          appInfo={props.appInfo}
          onChange={props.onSettings}
          onClose={() => setSettingsOpen(false)}
        />
      ) : redrob.isSuccess && !signedIn && !skipSignIn ? (
        <div className="rc-center">
          <SignIn onConnected={refreshSignIn} onSkip={() => setSkipSignIn(true)} />
        </div>
      ) : project ? (
        <Workspace key={project} directory={project} />
      ) : (
        <div className="rc-center">
          <EmptyState
            title={t("projects.title")}
            description={t("projects.empty")}
            action={
              <Button variant="primary" onClick={() => void pick()}>
                {t("projects.open")}
              </Button>
            }
          />
        </div>
      )}
    </AppShell>
  )
}
