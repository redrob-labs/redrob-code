import { useCallback, useEffect, useMemo, useState } from "react"
import type { AppInfo, EngineInfo, EngineState, Settings } from "@redrob-code/desktop/bridge"
import { EngineProvider } from "./engine"
import { I18nContext, translate, type Translate } from "./i18n"
import { Consent } from "./views/Consent"
import { NotDesktop, Startup } from "./views/Startup"
import { Home } from "./views/Home"

/**
 * The top of the interface: wait for the engine, ask for consent once, then the app.
 *
 * Sign-in is not a gate. The engine also works with a person's own provider keys, so the sign-in
 * card is offered inside the app rather than standing in front of it.
 */
export function App() {
  const bridge = window.redrobCode
  const [state, setState] = useState<EngineState>({ status: "starting" })
  const [info, setInfo] = useState<EngineInfo | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    if (!bridge) return
    void bridge.settings.get().then(setSettings)
    void bridge.app.info().then(setAppInfo)
    return bridge.engine.onState((next) => {
      setState(next)
      if (next.status === "ready") void bridge.engine.info().then(setInfo)
      else setInfo(null)
    })
  }, [bridge])

  const language = settings?.language ?? "en"
  const t = useCallback<Translate>((key, vars) => translate(language, key, vars), [language])
  useTheme(settings?.theme ?? "system")
  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  const update = useMemo(
    () => async (patch: Partial<Settings>) => {
      if (!bridge) return
      setSettings(await bridge.settings.set(patch))
    },
    [bridge],
  )

  if (!bridge) return <NotDesktop />

  return (
    <I18nContext.Provider value={t}>
      {!settings || !info ? (
        <Startup state={state} />
      ) : !settings.consent.decided ? (
        <Consent settings={settings} onDone={update} />
      ) : (
        <EngineProvider info={info}>
          <Home settings={settings} appInfo={appInfo} engineState={state} onSettings={update} />
        </EngineProvider>
      )}
    </I18nContext.Provider>
  )
}

/** Applies the theme the way redrob-ui reads it: `data-theme` on the root element. */
function useTheme(mode: Settings["theme"]) {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const apply = () => {
      const dark = mode === "dark" || (mode === "system" && media.matches)
      document.documentElement.dataset["theme"] = dark ? "dark" : "light"
      document.documentElement.dataset["themeMode"] = mode
    }
    apply()
    media.addEventListener("change", apply)
    return () => media.removeEventListener("change", apply)
  }, [mode])
}
