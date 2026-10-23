export * as MobileProfile from "./mobile"

/**
 * The mobile permission profile (redrob-mobile `docs/desk-relay.md`, "Mobile profile").
 *
 * A session created or prompted from a paired phone is marked here by the desk relay forwarder
 * (`packages/redrob/src/desk/forward.ts`). While a session is marked:
 *
 * - saved "always allow" permissions do not apply to it: the desktop's remembered approvals are not
 *   the phone's;
 * - every dangerous action asks, even where the agent's configured ruleset says allow. Dangerous is
 *   the agent's own shell and file-write tools (`bash`, `edit`, `external_directory`) plus every
 *   action the forwarder classified as dangerous from MCP annotations (`app:*` tools).
 *
 * A configured `deny` still wins. The registry is process state on `globalThis` under a
 * `Symbol.for` key, so the forwarder (same process inside `redrob serve --register`) and this
 * module agree even when the bundler loads two copies. Marks are not persisted: after a restart a
 * session becomes mobile again when the phone prompts it.
 */

const KEY = Symbol.for("redrob.mobile.permission-profile")

type Registry = {
  readonly sessions: Set<string>
  readonly dangerousActions: Set<string>
}

/** Agent tools that are dangerous when the phone is driving, whatever their annotations. */
export const AGENT_DANGEROUS_ACTIONS: readonly string[] = ["bash", "edit", "external_directory"]

/** The name rule from the design: these verbs make a tool dangerous by name alone. */
export const DANGEROUS_NAME = /(delete|remove|send|share|pay|purchase|transfer|publish)/i

function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>
  let value = holder[KEY]
  if (!value) {
    value = { sessions: new Set(), dangerousActions: new Set() }
    holder[KEY] = value
  }
  return value
}

export function mark(sessionID: string): void {
  registry().sessions.add(sessionID)
}

export function unmark(sessionID: string): void {
  registry().sessions.delete(sessionID)
}

export function isMobile(sessionID: string): boolean {
  return registry().sessions.has(sessionID)
}

/** Replace the set of actions the transport classified as dangerous (from `GET /v1/apps` + MCP annotations). */
export function setDangerousActions(actions: Iterable<string>): void {
  const set = registry().dangerousActions
  set.clear()
  for (const action of actions) set.add(action)
}

export function isDangerous(action: string): boolean {
  if (AGENT_DANGEROUS_ACTIONS.includes(action)) return true
  if (registry().dangerousActions.has(action)) return true
  // An app tool the transport has not classified yet has no annotations as far as we know.
  if (action.startsWith("app:") || action.startsWith("app_")) return true
  return DANGEROUS_NAME.test(action)
}
