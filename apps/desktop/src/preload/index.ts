import { contextBridge, ipcRenderer } from "electron"
import { Channel, type RedrobCodeBridge } from "../shared/bridge"

/**
 * Exposes `window.redrobCode` and nothing else. Every method is a named channel; the interface never
 * gets `ipcRenderer` itself, so it cannot reach a handler this file does not name.
 */

function subscribe<T>(channel: string, callback: (value: T) => void) {
  const listener = (_event: unknown, value: T) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const bridge: RedrobCodeBridge = {
  engine: {
    info: () => ipcRenderer.invoke(Channel.engineInfo),
    restart: () => ipcRenderer.invoke(Channel.engineRestart),
    logs: () => ipcRenderer.invoke(Channel.engineLogs),
    onState: (callback) => {
      // Late subscribers get the current state immediately, then every change.
      void ipcRenderer.invoke(Channel.engineState).then(callback)
      return subscribe(Channel.engineState, callback)
    },
  },
  signIn: {
    start: () => ipcRenderer.invoke(Channel.signInStart),
    cancel: () => ipcRenderer.invoke(Channel.signInCancel),
    onProgress: (callback) => subscribe(Channel.signInProgress, callback),
  },
  pickDirectory: () => ipcRenderer.invoke(Channel.pickDirectory),
  openExternal: (url) => ipcRenderer.invoke(Channel.openExternal, url),
  gitChanges: (directory) => ipcRenderer.invoke(Channel.gitChanges, directory),
  cli: {
    status: () => ipcRenderer.invoke(Channel.cliStatus),
    install: () => ipcRenderer.invoke(Channel.cliInstall),
  },
  settings: {
    get: () => ipcRenderer.invoke(Channel.settingsGet),
    set: (patch) => ipcRenderer.invoke(Channel.settingsSet, patch),
  },
  updater: {
    check: () => ipcRenderer.invoke(Channel.updaterCheck),
    install: () => ipcRenderer.invoke(Channel.updaterInstall),
    onState: (callback) => {
      void ipcRenderer.invoke(Channel.updaterState).then(callback)
      return subscribe(Channel.updaterState, callback)
    },
  },
  app: { info: () => ipcRenderer.invoke(Channel.appInfo) },
  buildoff: {
    start: (request) => ipcRenderer.invoke(Channel.buildoffStart, request),
    cancel: (runId) => ipcRenderer.invoke(Channel.buildoffCancel, runId),
    onMessage: (callback) => subscribe(Channel.buildoffMessage, callback),
    history: (directory) => ipcRenderer.invoke(Channel.buildoffHistory, directory),
    diff: (directory, contest, slot) => ipcRenderer.invoke(Channel.buildoffDiff, directory, contest, slot),
    pick: (directory, contest, slot, reasons) =>
      ipcRenderer.invoke(Channel.buildoffPick, directory, contest, slot, reasons ?? []),
    apply: (directory, contest, strategy) => ipcRenderer.invoke(Channel.buildoffApply, directory, contest, strategy),
    preview: (directory, contest, slot) => ipcRenderer.invoke(Channel.buildoffPreview, directory, contest, slot),
  },
}

contextBridge.exposeInMainWorld("redrobCode", bridge)
