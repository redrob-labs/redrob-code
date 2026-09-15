import type { TuiPluginApi } from "@redrob-code/plugin/tui"
import { RGBA } from "@opentui/core"
import { createTuiResolvedConfig } from "./tui-runtime"
import { formatKeyBindings, formatKeySequence } from "../../src/keymap"

type Opts = {
  client?: TuiPluginApi["client"]
  keymap?: TuiPluginApi["keymap"]
  attention?: Partial<TuiPluginApi["attention"]>
  event?: TuiPluginApi["event"]
  state?: { session?: Partial<TuiPluginApi["state"]["session"]> }
  // Seeds the plugin KV store the same way the persisted kv.json would.
  kv?: Record<string, unknown>
}

export function createTuiPluginApi(opts: Opts = {}) {
  const values = new Map<string, unknown>(Object.entries(opts.kv ?? {}))
  const color = RGBA.fromInts(200, 200, 200)
  const dialog = { clear() {}, replace() {}, setSize() {}, size: "medium" as const, depth: 0, open: false }
  const tuiConfig = createTuiResolvedConfig()
  return {
    attention: { notify: async () => ({ ok: false, notification: false, sound: false }), ...opts.attention },
    client: opts.client,
    event: opts.event,
    keymap: opts.keymap,
    // The real formatters, so a plugin rendering a shortcut legend looks the same in tests.
    keys: {
      formatSequence: (parts: Parameters<typeof formatKeySequence>[0]) => formatKeySequence(parts, tuiConfig),
      formatBindings: (bindings: Parameters<typeof formatKeyBindings>[0]) => formatKeyBindings(bindings, tuiConfig),
    },
    kv: {
      get(name: string, fallback?: unknown) {
        return values.has(name) ? values.get(name) : fallback
      },
      set(name: string, value: unknown) {
        values.set(name, value)
      },
      ready: true,
    },
    state: { session: { get: () => undefined, ...opts.state?.session } },
    theme: { current: new Proxy({}, { get: () => color }) },
    tuiConfig,
    ui: { dialog },
  } as unknown as TuiPluginApi
}
