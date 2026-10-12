/**
 * The one contract between the Electron main process and the interface.
 *
 * The preload implements it with `ipcRenderer.invoke`, the interface reads it as `window.redrobCode`.
 * Nothing else crosses the boundary: the interface talks to the engine directly over HTTP with the
 * address and credentials it gets from `engine.info()`, and asks main only for what a web page
 * cannot do itself.
 *
 * Kept free of Electron and Node imports so the interface can import the types without pulling either
 * into a browser bundle.
 */

export const Channel = {
  engineInfo: "redrob-code:engine:info",
  engineRestart: "redrob-code:engine:restart",
  engineLogs: "redrob-code:engine:logs",
  engineState: "redrob-code:engine:state",
  signInStart: "redrob-code:sign-in:start",
  signInCancel: "redrob-code:sign-in:cancel",
  signInProgress: "redrob-code:sign-in:progress",
  pickDirectory: "redrob-code:dialog:pick-directory",
  openExternal: "redrob-code:shell:open-external",
  gitChanges: "redrob-code:git:changes",
  cliStatus: "redrob-code:cli:status",
  cliInstall: "redrob-code:cli:install",
  settingsGet: "redrob-code:settings:get",
  settingsSet: "redrob-code:settings:set",
  updaterCheck: "redrob-code:updater:check",
  updaterInstall: "redrob-code:updater:install",
  updaterState: "redrob-code:updater:state",
  appInfo: "redrob-code:app:info",
} as const

export type EngineState =
  | { status: "starting" }
  | { status: "ready"; url: string; version: string | null; source: EngineSource }
  | { status: "failed"; message: string; attempts: number }
  | { status: "stopped" }

/** Where the running engine binary came from. */
export type EngineSource = "override" | "cli" | "bundled"

export type EngineInfo = {
  url: string
  /** `Basic …`, for the Authorization header. */
  authorization: string
  /** The same credential without the scheme, for `?auth_token=` where a header cannot be set. */
  authToken: string
  source: EngineSource
  binary: string
}

export type SignInProgress =
  | { status: "waiting"; userCode: string; verificationUri: string; expiresAt: number }
  | { status: "connected"; accountName: string; keyName: string }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "cancelled" }
  | { status: "failed"; message: string }

export type GitChanges = {
  /** False when the folder is not a git repository; the other fields are then empty. */
  repository: boolean
  branch: string | null
  files: { path: string; status: "added" | "modified" | "deleted" | "renamed" | "untracked" }[]
  /** Unified diff of tracked changes against HEAD. Untracked files are listed, not diffed. */
  diff: string
  truncated: boolean
}

export type CliStatus = {
  /** A `redrob` binary was found where the official installer puts it, or on PATH. */
  installed: boolean
  path: string | null
  version: string | null
  /** The command the official installer runs on this platform, shown before running it. */
  installCommand: string
}

export type ThemeMode = "system" | "light" | "dark"
export type Language = "en" | "ko"
export type UpdateChannel = "stable" | "alpha"

export type Settings = {
  language: Language
  theme: ThemeMode
  updateChannel: UpdateChannel
  /** Prefer an installed `redrob` CLI over the bundled engine when the CLI is present. */
  preferInstalledCli: boolean
  /** Both default to false: nothing is sent until the person says yes. */
  consent: { crashReports: boolean; usageEvents: boolean; decided: boolean }
  recentProjects: string[]
}

export type UpdaterState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; version: string }
  | { status: "downloading"; percent: number }
  | { status: "ready"; version: string }
  | { status: "none" }
  | { status: "unsupported"; reason: string }
  | { status: "error"; message: string }

export type AppInfo = {
  version: string
  platform: "windows" | "macos" | "linux"
  arch: string
  packaged: boolean
}

export interface RedrobCodeBridge {
  engine: {
    info(): Promise<EngineInfo | null>
    restart(): Promise<void>
    logs(): Promise<string>
    onState(callback: (state: EngineState) => void): () => void
  }
  signIn: {
    start(): Promise<void>
    cancel(): Promise<void>
    onProgress(callback: (progress: SignInProgress) => void): () => void
  }
  pickDirectory(): Promise<string | null>
  openExternal(url: string): Promise<void>
  gitChanges(directory: string): Promise<GitChanges>
  cli: {
    status(): Promise<CliStatus>
    install(): Promise<{ ok: boolean; output: string }>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  updater: {
    check(): Promise<void>
    install(): Promise<void>
    onState(callback: (state: UpdaterState) => void): () => void
  }
  app: { info(): Promise<AppInfo> }
}

declare global {
  interface Window {
    redrobCode?: RedrobCodeBridge
  }
}
