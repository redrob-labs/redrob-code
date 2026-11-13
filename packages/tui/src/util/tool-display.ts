export function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

export function toolDisplayMetadata(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {}
  if (!("status" in state) || state.status === "pending") return {}
  if (!("structured" in state) || !state.structured || typeof state.structured !== "object") return {}
  if (Array.isArray(state.structured)) return {}
  return state.structured as Record<string, unknown>
}

const BROWSER_ACTIONS = ["open", "read", "click", "type", "scroll", "wait", "screenshot"] as const
type BrowserAction = (typeof BROWSER_ACTIONS)[number]

type BrowserKey =
  | "session.tool.browser"
  | "session.tool.browser.chrome"
  | "session.tool.browser.own"
  | `session.tool.browser.action.${BrowserAction}`

/**
 * The row for a `browser` tool call: the action in the person's language, what it acted on
 * (the page or the element), and, once the engine said so in `metadata.browser`, which browser
 * ran it: the person's own Chrome through the Redrob extension, or the engine's built-in one.
 */
export function browserLabel(
  t: (key: BrowserKey, params?: Record<string, string>) => string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
): string {
  const action = BROWSER_ACTIONS.find((name) => name === input.action)
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined)
  const target = text(input.url) ?? text(metadata.url) ?? text(input.ref) ?? text(input.text) ?? ""
  const row = t("session.tool.browser", {
    action: action ? t(`session.tool.browser.action.${action}`) : text(input.action) ?? "",
    target,
  }).trim()
  const where =
    metadata.browser === "chrome"
      ? t("session.tool.browser.chrome")
      : metadata.browser === "own"
        ? t("session.tool.browser.own")
        : undefined
  return where ? `${row} (${where})` : row
}
