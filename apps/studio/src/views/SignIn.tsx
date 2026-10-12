import { useEffect, useState } from "react"
import { Alert, Button, Card } from "@redrob-labs/ui"
import type { SignInProgress } from "@redrob-code/desktop/bridge"
import { useT } from "../i18n"

/**
 * Console sign-in. The interface only ever sees the user code and the outcome: the key travels from
 * the Console to the engine inside the main process.
 */
export function SignIn(props: { onConnected: () => void; onSkip?: () => void }) {
  const t = useT()
  const bridge = window.redrobCode!
  const [progress, setProgress] = useState<SignInProgress | null>(null)

  useEffect(
    () =>
      bridge.signIn.onProgress((next) => {
        setProgress(next)
        if (next.status === "connected") props.onConnected()
      }),
    [bridge, props.onConnected],
  )

  const waiting = progress?.status === "waiting" ? progress : null
  const problem =
    progress?.status === "denied"
      ? t("signIn.denied")
      : progress?.status === "expired"
        ? t("signIn.expired")
        : progress?.status === "failed"
          ? t("signIn.failed", { message: progress.message })
          : null

  return (
    <Card title={t("signIn.title")} description={t("signIn.body")} className="rc-narrow">
      <div className="rc-stack">
        {problem && <Alert tone="warning">{problem}</Alert>}
        {waiting ? (
          <>
            <p className="rc-muted">{t("signIn.waiting")}</p>
            <code className="rc-code">{waiting.userCode}</code>
            <div className="rc-row">
              <Button variant="secondary" onClick={() => void bridge.openExternal(waiting.verificationUri)}>
                {t("signIn.reopen")}
              </Button>
              <Button variant="ghost" onClick={() => void bridge.signIn.cancel()}>
                {t("signIn.cancel")}
              </Button>
            </div>
          </>
        ) : (
          <div className="rc-row">
            <Button variant="primary" onClick={() => void bridge.signIn.start()}>
              {t("signIn.start")}
            </Button>
            {props.onSkip && (
              <Button variant="ghost" onClick={props.onSkip}>
                {t("signIn.skip")}
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
