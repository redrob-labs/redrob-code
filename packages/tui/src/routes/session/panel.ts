// The session side panel's remembered mode, stored in kv.json under `sidebar`.
// `auto` shows it on wide terminals only (upstream's default), `hide` keeps it closed,
// and `show` keeps it open on a narrow terminal too, so a choice made there survives a restart.
export type PanelMode = "auto" | "hide" | "show"

export function panelVisible(mode: PanelMode, wide: boolean) {
  if (mode === "show") return true
  if (mode === "hide") return false
  return wide
}

// The mode to store after the toggle, given what is on screen now.
export function panelNext(visible: boolean, wide: boolean): PanelMode {
  if (visible) return "hide"
  return wide ? "auto" : "show"
}
