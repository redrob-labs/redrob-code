import { DialogSelect } from "../ui/dialog-select"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
import { useLanguage } from "../context/language"
import { isConsoleManagedProvider } from "../util/provider-origin"

type ProviderSource = { id: string; name: string; source: string }

/**
 * The providers a logout can act on: connected, and holding a key stored by this app (`source: "api"`,
 * what `/login` and `redrob providers login` write to `auth.json`). Keyless Redrob still lists as
 * connected with `source: "custom"`, and a console-managed provider is configured by the organization,
 * so neither has anything local to remove.
 */
export function logoutTargets(input: {
  all: ProviderSource[]
  connected: string[]
  consoleManaged: string[] | ReadonlySet<string>
}) {
  return input.all.filter(
    (provider) =>
      provider.source === "api" &&
      input.connected.includes(provider.id) &&
      !isConsoleManagedProvider(input.consoleManaged, provider.id),
  )
}

/**
 * A sign-in this app does not own: `REDROB_API_KEY` (`env`) or Redrob Desktop's shared account
 * (`launcher`). Logging out here cannot remove it.
 */
export function externalSignIn(all: ProviderSource[], connected: string[]) {
  return all.find(
    (provider) => connected.includes(provider.id) && (provider.source === "env" || provider.source === "launcher"),
  )
}

/**
 * `/logout`: the TUI side of `redrob providers logout`. Both end in the same `Auth.remove`, reached here
 * through `DELETE /auth/{providerID}`.
 */
export function useLogout() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const language = useLanguage()

  const pick = (targets: { id: string; name: string }[]) => {
    if (targets.length === 1) return Promise.resolve<string | null>(targets[0].id)
    return new Promise<string | null>((resolve) => {
      dialog.replace(
        () => (
          <DialogSelect
            title={language.t("auth.logout.select")}
            options={targets.map((x) => ({ title: x.name, value: x.id }))}
            onSelect={(option) => resolve(option.value)}
          />
        ),
        () => resolve(null),
      )
    })
  }

  return async () => {
    const targets = logoutTargets({
      all: sync.data.provider_next.all,
      connected: sync.data.provider_next.connected,
      consoleManaged: sync.data.console_state.consoleManagedProviders,
    })
    if (targets.length === 0) {
      dialog.clear()
      const external = externalSignIn(sync.data.provider_next.all, sync.data.provider_next.connected)
      toast.show({
        variant: "info",
        message: external
          ? language.t("auth.logout.external", { name: external.name })
          : language.t("auth.logout.none"),
      })
      return
    }
    const providerID = await pick(targets)
    if (!providerID) return
    const name = targets.find((x) => x.id === providerID)?.name ?? providerID
    const ok = await DialogConfirm.show(
      dialog,
      language.t("auth.logout.confirm.title"),
      language.t("auth.logout.confirm.message", { name }),
    )
    dialog.clear()
    if (ok !== true) return

    const result = await sdk.client.auth.remove({ providerID })
    if (result.error) {
      toast.show({ variant: "error", message: language.t("auth.logout.failed") })
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    // A key exported as REDROB_API_KEY or shared by Redrob Desktop is not ours to delete, so the
    // provider can stay signed in after its stored key is gone. Say so instead of "logged out".
    const after = externalSignIn(sync.data.provider_next.all, sync.data.provider_next.connected)
    if (after?.id === providerID) {
      toast.show({ variant: "warning", message: language.t("auth.logout.still_connected", { name }) })
      return
    }
    toast.show({ variant: "success", message: language.t("auth.logout.done", { name }) })
  }
}
