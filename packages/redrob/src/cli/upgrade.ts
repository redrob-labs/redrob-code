import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@redrob-code/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@redrob-code/core/installation/version"
import { GlobalBus } from "@/bus/global"

let staged: string | undefined

/** Start the Windows setup `upgrade()` downloaded, if any. Called once, as the TUI shuts down. */
export function launchStagedInstaller(launch = Installation.launchInstaller) {
  const file = staged
  staged = undefined
  if (file) launch(file)
  return file
}

export async function upgrade() {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  if (config.autoupdate === false || Flag.REDROB_DISABLE_AUTOUPDATE) return
  const method = await Installation.method()
  const latest = await Installation.latest().catch(() => {})
  if (!latest) return

  if (Flag.REDROB_ALWAYS_NOTIFY_UPDATE) {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  if (InstallationVersion === latest) return

  const kind = Installation.getReleaseType(InstallationVersion, latest)

  if (config.autoupdate === "notify" || kind !== "patch") {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  if (method === "unknown") return
  if (method === "installer") {
    // Starting the Windows setup now closes this open TUI mid-chat (its /CLOSEAPPLICATIONS goes
    // through the Restart Manager). Download it now and start it when the TUI quits instead.
    staged = await Installation.stage(latest).catch(() => undefined)
    return
  }
  await Installation.upgrade(method, latest)
    .then(() =>
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: latest },
        },
      }),
    )
    .catch(() => {})
}
