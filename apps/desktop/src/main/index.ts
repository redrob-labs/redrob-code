import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { BrowserWindow, app, dialog, ipcMain, net, protocol, shell } from "electron"
import { Channel, type AppInfo, type EngineState, type Settings, type UpdaterState } from "../shared/bridge"
import { cliStatus, runInstaller } from "./cli"
import { EngineManager } from "./engine"
import { findCli, resolveEngineBinary } from "./engine-binary"
import { gitChanges } from "./git"
import { RENDERER_HOST, RENDERER_SCHEME, RENDERER_URL, resolveRendererFile } from "./renderer-protocol"
import { createSettingsStore } from "./settings"
import { loadShellEnv } from "./shell-env"
import { consoleUrl, createSignIn } from "./sign-in"
import { createUpdater } from "./updater"

const DEEP_LINK_SCHEME = app.isPackaged ? "redrob-code" : "redrob-code-dev"
const SMOKE_TEST = process.argv.includes("--smoke-test")

protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
])

if (!SMOKE_TEST && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void main()
}

async function main() {
  await app.whenReady()

  const platform = process.platform
  const env = { ...process.env, ...loadShellEnv(platform, process.env) }
  const settings = createSettingsStore(app.getPath("userData"), app.getLocale())
  const repoRoot = app.isPackaged ? null : path.resolve(app.getAppPath(), "..", "..")
  let window: BrowserWindow | null = null

  const send = (channel: string, payload: unknown) => {
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }

  let engineState: EngineState = { status: "starting" }
  const resolved = resolveEngineBinary({
    platform,
    arch: process.arch,
    env,
    home: os.homedir(),
    resourcesPath: app.isPackaged ? process.resourcesPath : null,
    repoRoot,
    preferInstalledCli: settings.get().preferInstalledCli,
    exists: existsSync,
  })

  const engine = resolved
    ? new EngineManager({
        binary: resolved.binary,
        source: resolved.source,
        env,
        onState: (state) => {
          engineState = state
          send(Channel.engineState, state)
        },
      })
    : null

  if (SMOKE_TEST) return smokeTest(engine)

  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)
  const rendererRoot = app.isPackaged
    ? path.join(process.resourcesPath, "studio")
    : path.resolve(app.getAppPath(), "..", "studio", "dist")
  protocol.handle(RENDERER_SCHEME, (request) => {
    const file = resolveRendererFile(rendererRoot, request.url, existsSync)
    if (!file) return new Response("Not found", { status: 404 })
    return net.fetch(file)
  })

  let updaterState: UpdaterState = { status: "idle" }
  const updater = createUpdater({
    packaged: app.isPackaged,
    platform,
    env,
    onState: (state) => {
      updaterState = state
      send(Channel.updaterState, state)
    },
  })
  updater.setChannel(settings.get().updateChannel)

  const signIn = createSignIn({
    consoleUrl: consoleUrl(env),
    fetch: globalThis.fetch,
    openExternal: (url) => shell.openExternal(url),
    onProgress: (progress) => send(Channel.signInProgress, progress),
    storeKey: async (key, label) => {
      const info = engine?.current()
      if (!info) throw new Error("The engine is not running, so the key has nowhere to go.")
      const response = await fetch(`${info.url}/api/integration/redrob/connect/key`, {
        method: "POST",
        headers: { Authorization: info.authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ key, label }),
      })
      if (!response.ok) throw new Error(`The engine did not accept the key (${response.status}).`)
    },
  })

  ipcMain.handle(Channel.engineInfo, () => engine?.current() ?? null)
  ipcMain.handle(Channel.engineState, () => engineState)
  ipcMain.handle(Channel.engineLogs, () => engine?.output() ?? "")
  ipcMain.handle(Channel.engineRestart, async () => {
    await engine?.restart()
  })
  ipcMain.handle(Channel.signInStart, () => {
    void signIn.start()
  })
  ipcMain.handle(Channel.signInCancel, () => signIn.cancel())
  ipcMain.handle(Channel.pickDirectory, async () => {
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(Channel.openExternal, async (_event, url: unknown) => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) await shell.openExternal(url)
  })
  ipcMain.handle(Channel.gitChanges, (_event, directory: unknown) => {
    if (typeof directory !== "string" || !path.isAbsolute(directory))
      throw new Error("An absolute folder path is required.")
    return gitChanges(directory)
  })
  ipcMain.handle(Channel.cliStatus, () =>
    cliStatus(findCli({ platform, env, home: os.homedir(), exists: existsSync }), platform),
  )
  ipcMain.handle(Channel.cliInstall, () => runInstaller(platform, env))
  ipcMain.handle(Channel.settingsGet, () => settings.get())
  ipcMain.handle(Channel.settingsSet, (_event, patch: Partial<Settings>) => {
    const next = settings.set(patch ?? {})
    if (patch?.updateChannel) updater.setChannel(next.updateChannel)
    return next
  })
  ipcMain.handle(Channel.updaterCheck, () => updater.check())
  ipcMain.handle(Channel.updaterInstall, () => updater.install())
  ipcMain.handle(Channel.updaterState, () => updaterState)
  ipcMain.handle(
    Channel.appInfo,
    (): AppInfo => ({
      version: app.getVersion(),
      platform: platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux",
      arch: process.arch,
      packaged: app.isPackaged,
    }),
  )

  const createWindow = () => {
    window = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 900,
      minHeight: 600,
      show: false,
      title: "Redrob Code",
      backgroundColor: "#111214",
      titleBarStyle: platform === "darwin" ? "hiddenInset" : platform === "win32" ? "hidden" : "default",
      titleBarOverlay: platform === "win32" ? { color: "#00000000", symbolColor: "#8a8f98", height: 40 } : false,
      webPreferences: {
        preload: path.join(app.getAppPath(), "out", "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    })
    window.once("ready-to-show", () => window?.show())
    // Links open in the browser, never inside the app window.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: "deny" }
    })
    window.webContents.on("will-navigate", (event, url) => {
      const devUrl = env["REDROB_CODE_STUDIO_URL"]
      const internal = url.startsWith(`${RENDERER_SCHEME}://${RENDERER_HOST}/`) || (devUrl && url.startsWith(devUrl))
      if (internal) return
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    })
    const devUrl = !app.isPackaged ? env["REDROB_CODE_STUDIO_URL"] : undefined
    void window.loadURL(devUrl ?? RENDERER_URL)
    window.on("closed", () => (window = null))
  }

  createWindow()
  app.on("second-instance", () => {
    if (!window) return createWindow()
    if (window.isMinimized()) window.restore()
    window.focus()
  })
  app.on("activate", () => {
    if (!window) createWindow()
  })
  app.on("window-all-closed", () => {
    if (platform !== "darwin") app.quit()
  })
  let quitting = false
  app.on("before-quit", (event) => {
    if (quitting || !engine) return
    event.preventDefault()
    quitting = true
    void engine.stop().finally(() => app.quit())
  })

  if (!engine) {
    engineState = {
      status: "failed",
      message: "No Redrob Code engine was found in this app. Reinstall it, or set REDROB_CODE_BIN.",
      attempts: 0,
    }
    send(Channel.engineState, engineState)
  } else {
    await engine.start().catch(() => undefined)
  }
  if (app.isPackaged) void updater.check()
}

/**
 * `--smoke-test`: start the engine the packaged app would start, prove it answers an authenticated
 * health check, stop it, and exit 0 -- or 1 with the reason. CI runs this against the packaged build,
 * so a release cannot ship an app whose engine does not start.
 */
async function smokeTest(engine: EngineManager | null) {
  const fail = (message: string) => {
    console.error(`smoke test failed: ${message}`)
    app.exit(1)
  }
  if (!engine) return fail("no engine binary was found")
  try {
    const info = await engine.start()
    const response = await fetch(`${info.url}/api/health`, { headers: { Authorization: info.authorization } })
    const body = (await response.json()) as { healthy?: boolean }
    if (!response.ok || body.healthy !== true) return fail(`health answered ${response.status}`)
    const refused = await fetch(`${info.url}/api/health`)
    if (refused.status !== 401) return fail(`an unauthenticated request was answered ${refused.status}, not 401`)
    console.log(`smoke test passed: ${info.source} engine at ${info.url}`)
    await engine.stop()
    app.exit(0)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}
