/** @jsxImportSource @opentui/solid */
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { JSX } from "solid-js"
import { TuiConfigProvider, type Resolved } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { LanguageProvider } from "../../src/context/language"
import { ThemeProvider } from "../../src/context/theme"
import { RedrobKeymapProvider, type OpenTuiKeymap } from "../../src/keymap"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { TestTuiContexts } from "./tui-environment"

// The locale is seeded through the persisted KV file, which is the same path `/language`
// writes. Plugin bootstrap code reads that file too, so the render tree and the code
// registering commands outside it agree on the locale.
export async function localeState(root: string, locale: "en" | "ko") {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), JSON.stringify({ language: locale }))
  return state
}

export function LocaleHarness(props: {
  root: string
  state: string
  keymap: OpenTuiKeymap
  config: Resolved
  children: JSX.Element
}) {
  return (
    <TestTuiContexts directory={props.root} paths={{ home: props.root, state: props.state, worktree: props.root }}>
      <RedrobKeymapProvider keymap={props.keymap}>
        <TuiConfigProvider config={props.config}>
          <KVProvider>
            <LanguageProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>{props.children}</DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </LanguageProvider>
          </KVProvider>
        </TuiConfigProvider>
      </RedrobKeymapProvider>
    </TestTuiContexts>
  )
}
