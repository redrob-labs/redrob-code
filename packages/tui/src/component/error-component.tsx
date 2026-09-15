import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Show } from "solid-js"
import { getScrollAcceleration } from "../util/scroll"
import { useClipboard } from "../context/clipboard"
import { InstallationVersion } from "@redrob-code/core/installation/version"
import { Brand } from "@redrob-code/core/theme/brand"
import { useExit } from "../context/exit"
import { describeOS, describeTerminal } from "../util/system"
import { useLanguage } from "../context/language"

export function ErrorComponent(props: { error: Error; reset: () => void; mode?: "dark" | "light" }) {
  const term = useTerminalDimensions()
  const exit = useExit()
  const language = useLanguage()
  const clipboard = useClipboard()
  const [copied, setCopied] = createSignal(false)

  // Safe fallback palette per mode, read straight off the brand primitives so it cannot drift from
  // theme/assets/redrob.json, which maps the same steps to the same roles. It exists because the
  // theme context may be the thing that crashed, so nothing here may resolve a theme.
  const isLight = props.mode === "light"
  const colors = isLight
    ? {
        bg: Brand.gray1,
        element: Brand.gray2,
        borderSubtle: Brand.gray4,
        text: Brand.gray9,
        muted: Brand.gray7,
        primary: Brand.blue6,
        onPrimary: Brand.gray1,
        error: Brand.red4,
        success: Brand.green5,
      }
    : {
        bg: Brand.gray9,
        element: Brand.gray8,
        borderSubtle: Brand.gray7,
        text: Brand.gray1,
        muted: Brand.gray5,
        primary: Brand.blue4,
        onPrimary: Brand.gray9,
        error: Brand.red3,
        success: Brand.green3,
      }

  const message = props.error.message || language.t("crash.unknown_error")
  const stack = props.error.stack || language.t("crash.no_stack")
  const issueURL = buildIssueURL(message, stack)

  const copyReport = () => {
    void clipboard.write?.(issueURL.toString()).then(() => setCopied(true))
  }

  const actions = [
    {
      key: "c",
      label: () => (copied() ? language.t("crash.action.copied") : language.t("crash.action.copy")),
      copy: true,
      onUse: copyReport,
    },
    { key: "r", label: () => language.t("crash.action.restart"), onUse: props.reset },
    { key: "q", label: () => language.t("crash.action.quit"), onUse: () => exit() },
  ]
  const [selected, setSelected] = createSignal(0)
  const move = (delta: number) => setSelected((prev) => (prev + delta + actions.length) % actions.length)
  let scroll: ScrollBoxRenderable | undefined

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "c") return exit()
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      return actions[selected()].onUse()
    }
    if (evt.name === "left") {
      evt.preventDefault()
      evt.stopPropagation()
      return move(-1)
    }
    if (evt.name === "right") {
      evt.preventDefault()
      evt.stopPropagation()
      return move(1)
    }
    if (evt.name === "tab") {
      evt.preventDefault()
      evt.stopPropagation()
      return move(evt.shift ? -1 : 1)
    }
    // Vertical keys scroll the stack trace; buttons navigate horizontally.
    if (evt.name === "up") return scroll?.scrollBy(-1)
    if (evt.name === "down") return scroll?.scrollBy(1)
    if (evt.name === "pageup" && scroll) return scroll.scrollBy(-scroll.height)
    if (evt.name === "pagedown" && scroll) return scroll.scrollBy(scroll.height)
    if (evt.name === "home" && scroll) return scroll.scrollTo(0)
    if (evt.name === "end" && scroll) return scroll.scrollTo(scroll.scrollHeight)
    if (evt.name === "q") return exit()
    if (evt.name === "c") return copyReport()
    if (evt.name === "r") return props.reset()
  })

  // Responsive thresholds.
  const contentWidth = () => Math.min(84, Math.max(24, term().width - 4))
  const showSubtext = () => term().height >= 18
  const showFooter = () => term().height >= 20

  return (
    <box
      width={term().width}
      height={term().height}
      backgroundColor={colors.bg}
      flexDirection="column"
      alignItems="center"
    >
      <box width={contentWidth()} flexGrow={1} flexDirection="column" paddingTop={1} paddingBottom={1} gap={1}>
        {/* Headline */}
        <box flexDirection="column" alignItems="center" flexShrink={0}>
          <text attributes={TextAttributes.BOLD} fg={colors.text}>
            {language.t("crash.title")}
          </text>
          <Show when={showSubtext()}>
            <text fg={colors.muted}>{language.t("crash.subtitle")}</text>
          </Show>
        </box>

        {/* Error message panel */}
        <box
          flexShrink={0}
          border
          borderStyle="rounded"
          borderColor={colors.error}
          title={language.t("crash.error_panel")}
          titleColor={colors.error}
          paddingLeft={2}
          paddingRight={2}
        >
          <text fg={colors.text}>{message}</text>
        </box>

        {/* Actions */}
        <box flexDirection="row" flexWrap="wrap" justifyContent="center" gap={2} rowGap={1} flexShrink={0}>
          <For each={actions}>
            {(action, index) => {
              const isSelected = () => selected() === index()
              const isCopied = () => action.copy && copied()
              return (
                <box flexDirection="column" alignItems="center" flexShrink={0}>
                  <box
                    onMouseDown={() => setSelected(index())}
                    onMouseUp={() => action.onUse()}
                    backgroundColor={isCopied() ? colors.success : isSelected() ? colors.primary : colors.element}
                    minWidth={15}
                    alignItems="center"
                    paddingLeft={2}
                    paddingRight={2}
                  >
                    <text
                      attributes={TextAttributes.BOLD}
                      fg={isCopied() || isSelected() ? colors.onPrimary : colors.text}
                    >
                      {action.label()}
                    </text>
                  </box>
                  <text fg={isSelected() ? colors.primary : colors.muted}>{action.key}</text>
                </box>
              )
            }}
          </For>
        </box>

        {/* Stack trace */}
        <box
          flexGrow={1}
          flexBasis={0}
          minHeight={3}
          border
          borderStyle="rounded"
          borderColor={colors.borderSubtle}
          title={language.t("crash.stack_panel")}
          titleColor={colors.muted}
          bottomTitle={language.t("crash.scroll_hint")}
          bottomTitleAlignment="right"
          paddingLeft={1}
          paddingRight={1}
        >
          <scrollbox
            ref={(element: ScrollBoxRenderable) => (scroll = element)}
            flexGrow={1}
            scrollAcceleration={getScrollAcceleration()}
          >
            <text fg={colors.muted}>{stack}</text>
          </scrollbox>
        </box>

        {/* Footer */}
        <Show when={showFooter()}>
          <box flexDirection="column" alignItems="center" flexShrink={0}>
            <text fg={colors.muted}>
              {copied() ? language.t("crash.footer.copied") : language.t("crash.footer.default")}
            </text>
            <text fg={colors.muted}>Redrob Code {InstallationVersion}</text>
          </box>
        </Show>
      </box>
    </box>
  )
}

function buildIssueURL(message: string, stack: string) {
  // There is no issue form to pre-fill, so system info goes inline in the body rather
  // than into per-field ids that only an issue template would understand.
  const url = new URL("https://github.com/redrob-labs/redrob-code/issues/new")
  url.searchParams.set("title", `TUI crash: ${message}`)

  // Budget the stack against the fully URL-encoded length (not the raw length) so
  // the final link stays under GitHub's practical limit; flag truncation so a
  // clipped trace is obvious. searchParams.set handles encoding without throwing,
  // so measuring url.toString() is both correct and safe on any input.
  const MAX_URL_LENGTH = 6000
  const marker = "\n... (truncated)"
  const head = `The Redrob Code TUI crashed with an unexpected error.\n\n**Version:** ${InstallationVersion}\n**OS:** ${describeOS()}\n**Terminal:** ${describeTerminal()}\n\n**Error:** ${message}\n\n**Stack trace:**\n`
  const setBody = (body: string) => url.searchParams.set("body", head + "```\n" + body + "\n```")

  setBody(stack)
  if (url.toString().length <= MAX_URL_LENGTH) return url

  // Largest raw stack prefix whose encoded URL (with the marker) still fits.
  let lo = 0
  let hi = stack.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    setBody(stack.slice(0, mid) + marker)
    if (url.toString().length <= MAX_URL_LENGTH) lo = mid
    else hi = mid - 1
  }
  setBody(stack.slice(0, lo) + marker)
  return url
}
