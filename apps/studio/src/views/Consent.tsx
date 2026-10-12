import { useState } from "react"
import { Button, Card, Switch } from "@redrob-labs/ui"
import type { Settings } from "@redrob-code/desktop/bridge"
import { useT } from "../i18n"

/**
 * The first-run privacy choice: two separate switches, both off, nothing pre-ticked. Continuing with
 * both off is a complete answer, and the choice can be changed in Settings at any time.
 */
export function Consent(props: { settings: Settings; onDone: (patch: Partial<Settings>) => void }) {
  const t = useT()
  const [crash, setCrash] = useState(props.settings.consent.crashReports)
  const [usage, setUsage] = useState(props.settings.consent.usageEvents)
  return (
    <main className="rc-center">
      <Card
        title={t("consent.title")}
        description={t("consent.body")}
        footer={
          <Button
            variant="primary"
            onClick={() => props.onDone({ consent: { crashReports: crash, usageEvents: usage, decided: true } })}
          >
            {t("consent.continue")}
          </Button>
        }
        className="rc-narrow"
      >
        <div className="rc-stack">
          <Switch label={t("consent.crash")} checked={crash} onChange={(event) => setCrash(event.target.checked)} />
          <Switch label={t("consent.usage")} checked={usage} onChange={(event) => setUsage(event.target.checked)} />
        </div>
      </Card>
    </main>
  )
}
