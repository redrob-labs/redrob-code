import { useState } from "react"
import { Alert, Button, EmptyState, Loader } from "@redrob-labs/ui"
import type { EngineState } from "@redrob-code/desktop/bridge"
import { translate, useT } from "../i18n"

export function NotDesktop() {
  return (
    <main className="rc-center">
      <EmptyState title={translate("en", "app.name")} description={translate("en", "app.notDesktop")} />
    </main>
  )
}

export function Startup(props: { state: EngineState }) {
  const t = useT()
  const [logs, setLogs] = useState<string | null>(null)
  const bridge = window.redrobCode!

  if (props.state.status !== "failed") {
    return (
      <main className="rc-center">
        <Loader label={t("engine.starting")} showLabel size="lg" />
      </main>
    )
  }

  return (
    <main className="rc-center rc-stack">
      <Alert
        tone="danger"
        title={t("engine.failed")}
        action={
          <Button variant="primary" onClick={() => void bridge.engine.restart()}>
            {t("engine.restart")}
          </Button>
        }
      >
        {props.state.message}
      </Alert>
      <Button variant="ghost" onClick={() => void bridge.engine.logs().then(setLogs)}>
        {t("engine.logs")}
      </Button>
      {logs !== null && <pre className="rc-log">{logs || "—"}</pre>}
    </main>
  )
}
