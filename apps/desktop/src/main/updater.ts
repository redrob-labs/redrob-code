import electronUpdater from "electron-updater"
import type { UpdateChannel, UpdaterState } from "../shared/bridge"

/**
 * App updates, from this repository's GitHub Releases.
 *
 * The desktop installers and their `latest.yml` feed are uploaded to the same release as the CLI
 * archives, under names the CLI installer never matches (`redrob-code-desktop-*`). Stable reads the
 * newest full release; alpha also accepts prereleases, which `install.sh` and `redrob upgrade` ignore,
 * so an alpha desktop build never reaches a CLI user.
 *
 * The engine inside the app is updated with the app. It never updates itself (the engine is started
 * with REDROB_DISABLE_AUTOUPDATE), and a separately installed CLI keeps its own `redrob upgrade`.
 */

const { autoUpdater } = electronUpdater

export function createUpdater(options: {
  packaged: boolean
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  onState: (state: UpdaterState) => void
}) {
  let state: UpdaterState = { status: "idle" }
  const emit = (next: UpdaterState) => {
    state = next
    options.onState(next)
  }

  const reason = !options.packaged
    ? "Updates apply to installed builds only."
    : options.platform === "linux" && !options.env["APPIMAGE"]
      ? "This Linux package is updated by its package manager."
      : null

  if (!reason) {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on("checking-for-update", () => emit({ status: "checking" }))
    autoUpdater.on("update-available", (info) => emit({ status: "available", version: info.version }))
    autoUpdater.on("update-not-available", () => emit({ status: "none" }))
    autoUpdater.on("download-progress", (progress) =>
      emit({ status: "downloading", percent: Math.round(progress.percent) }),
    )
    autoUpdater.on("update-downloaded", (info) => emit({ status: "ready", version: info.version }))
    autoUpdater.on("error", (error) => emit({ status: "error", message: error?.message ?? String(error) }))
  }

  return {
    state: () => state,
    setChannel(channel: UpdateChannel) {
      if (reason) return
      autoUpdater.allowPrerelease = channel === "alpha"
      // Leaving alpha for stable means going to a LOWER version; without this the app would stay on
      // the alpha it has until stable overtakes it.
      autoUpdater.allowDowngrade = channel === "stable"
    },
    async check() {
      if (reason) return emit({ status: "unsupported", reason })
      try {
        await autoUpdater.checkForUpdates()
      } catch (error) {
        emit({ status: "error", message: error instanceof Error ? error.message : String(error) })
      }
    },
    install() {
      if (state.status === "ready") autoUpdater.quitAndInstall()
    },
  }
}
