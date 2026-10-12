import { BrowserWindow, shell } from "electron"
import {
  apply,
  candidateDiff,
  connect,
  history,
  pick,
  runContest,
  startPreview,
  type ContestEvent,
  type ContestResult,
  type Preview,
} from "@redrob-code/contest"
import type { BuildoffMessage, BuildoffStart } from "../shared/bridge"
import type { EngineManager } from "./engine"

/**
 * Build-offs, hosted in the main process.
 *
 * The contest library drives the engine over its HTTP API exactly as `redrob buildoff` does, so the
 * app and the CLI run one implementation. The renderer only ever receives the ANONYMOUS result; the
 * model behind each slot reaches it through `pick`, which records the choice before it reveals.
 */

export function createBuildoffHost(input: {
  engine: () => EngineManager | null
  send: (message: BuildoffMessage) => void
}) {
  const runs = new Map<string, AbortController>()
  const previews = new Map<string, { preview: Preview; window: BrowserWindow | null }>()
  let counter = 0

  const client = () => {
    const info = input.engine()?.current()
    if (!info) throw new Error("The engine is not running.")
    return connect(info.url, info.authorization)
  }

  return {
    start(request: BuildoffStart) {
      const runId = `run-${Date.now().toString(36)}-${++counter}`
      const controller = new AbortController()
      runs.set(runId, controller)
      const engine = client()
      void runContest(engine, {
        directory: request.directory,
        task: request.task,
        builders: request.builders,
        budgetUsd: request.budgetUsd,
        minutes: request.minutes,
        gatePercentile: request.gatePercentile,
        signal: controller.signal,
        onEvent: (event: ContestEvent) => input.send({ runId, kind: "event", event }),
      })
        .then((result: ContestResult) => input.send({ runId, kind: "result", result }))
        .catch((error: unknown) =>
          input.send({ runId, kind: "error", message: error instanceof Error ? error.message : String(error) }),
        )
        .finally(() => runs.delete(runId))
      return { runId }
    },
    cancel(runId: string) {
      runs.get(runId)?.abort()
    },
    history: (directory: string) => history(directory),
    diff: (directory: string, contest: string, slot: string) => candidateDiff(directory, contest, slot),
    pick: (directory: string, contest: string, slot: string, reasons: string[]) =>
      pick(directory, contest, slot, reasons),
    apply: (directory: string, contest: string, strategy: "branch" | "commit") => apply(directory, contest, strategy),

    async preview(directory: string, contest: string, slot: string) {
      const key = `${contest}/${slot}`
      const existing = previews.get(key)
      if (existing) {
        existing.window?.focus()
        return { url: existing.preview.url }
      }
      const preview = await startPreview({ directory, contest, slot })
      // A plain, sandboxed window with no preload: the candidate's own code runs in it, and it must not
      // reach the app's bridge. Links leave for the browser.
      const window = new BrowserWindow({
        width: 1100,
        height: 760,
        title: `Candidate ${slot} — preview`,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      })
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
        return { action: "deny" }
      })
      window.on("closed", () => {
        previews.delete(key)
        void preview.stop()
      })
      previews.set(key, { preview, window })
      await window.loadURL(preview.url)
      return { url: preview.url }
    },

    async dispose() {
      for (const controller of runs.values()) controller.abort()
      for (const { preview, window } of previews.values()) {
        window?.destroy()
        await preview.stop()
      }
      previews.clear()
    },
  }
}
