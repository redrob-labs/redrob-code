export * as MobileProfile from "./mobile"

/**
 * The mobile permission profile (redrob-mobile `docs/desk-relay.md`, "Mobile profile").
 *
 * A session created or prompted from a paired device (the phone app or a web browser) is marked
 * here by the desk relay forwarder (`packages/redrob/src/desk/forward.ts`). While a session is
 * marked:
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

/**
 * The approval mode the device picked for a session (header `X-Redrob-Approval`):
 *
 * - `ask`: every dangerous action asks (the profile above; also what an old app without the header gets);
 * - `edits`: file edits inside the project folder run right away; commands and outside folders ask;
 * - `all`: nothing asks except the rules in `KEEP_ASKING`. The forwarder only grants it while the
 *   launcher's switch (`~/.redrob/desk/settings.json` `allowAutoAll`) is not turned off.
 *
 * A configured `deny` wins in every mode.
 */
export type ApprovalMode = "ask" | "edits" | "all"
export const APPROVAL_MODES: readonly ApprovalMode[] = ["ask", "edits", "all"]

/** Rules that ask in every mode, even `all`. */
export const KEEP_ASKING: readonly string[] = ["doom_loop"]

type Registry = {
  readonly sessions: Set<string>
  readonly modes: Map<string, ApprovalMode>
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
    value = { sessions: new Set(), modes: new Map(), dangerousActions: new Set() }
    holder[KEY] = value
  }
  // A registry made by an older copy of this module has no modes map.
  if (!value.modes) (value as { modes: Map<string, ApprovalMode> }).modes = new Map()
  return value
}

/** Mark a session as driven from a device, in the mode it asked for (each prompt updates it). */
export function mark(sessionID: string, mode: ApprovalMode = "ask"): void {
  const value = registry()
  value.sessions.add(sessionID)
  value.modes.set(sessionID, mode)
}

export function unmark(sessionID: string): void {
  const value = registry()
  value.sessions.delete(sessionID)
  value.modes.delete(sessionID)
}

export function mode(sessionID: string): ApprovalMode {
  return registry().modes.get(sessionID) ?? "ask"
}

/** A permission resource inside the project: edit resources are Location-relative there, canonical outside. */
function insideProject(resource: string): boolean {
  if (resource === "" || resource === "*") return false
  if (resource.startsWith("/") || resource.startsWith("\\") || /^[A-Za-z]:/.test(resource)) return false
  return !resource.split(/[\\/]/).includes("..")
}

/**
 * The effect for one resource of a marked session, after the configured `deny` check.
 * `configured` is what the agent's own ruleset says for it (saved approvals are not used here).
 */
export function decide(sessionID: string, action: string, resource: string, configured: "allow" | "ask" | "deny"): "allow" | "ask" | "deny" {
  if (configured === "deny") return "deny"
  if (KEEP_ASKING.includes(action)) return "ask"
  const current = mode(sessionID)
  if (current === "all") return "allow"
  if (current === "edits" && action === "edit" && insideProject(resource)) return "allow"
  if (isDangerous(action)) return "ask"
  return configured
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
