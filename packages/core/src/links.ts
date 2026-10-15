// Leaf module holding every public Redrob Code URL that ships in the binary. Dependency-free
// on purpose so core, the CLI and the TUI can all import it without pulling in anything heavier.
//
// There is NO host called code.redrob.ai. Everything user-facing lives under the Console:
// the product page, the docs, the install script, and the JSON Schemas that editors fetch from a
// config file's `$schema` field. Keep the literals here so a dead link cannot creep back in one
// file at a time; JSON assets (packages/redrob/config.json, the TUI theme files) repeat the
// schema URLs as literals because JSON cannot import, and `redrob generate` regenerates the schema
// documents at `packages/redrob/schema/*.json` with matching `$id`s.

export const CONSOLE_HOME_URL = "https://console.redrob.ai"
export const CODE_HOME_URL = `${CONSOLE_HOME_URL}/code`
export const CODE_DOCS_URL = `${CONSOLE_HOME_URL}/docs`
export const CODE_INSTALL_URL = `${CODE_HOME_URL}/install.sh`
export const CODE_INSTALL_COMMAND = `curl -fsSL ${CODE_INSTALL_URL} | sh`

/** `$schema` for redrob.json / redrob.jsonc (generated from ConfigV1.Info). */
export const CONFIG_SCHEMA_URL = `${CODE_HOME_URL}/config.json`
/** `$schema` for tui.json (generated from TuiConfig.Info). */
export const TUI_SCHEMA_URL = `${CODE_HOME_URL}/tui.json`
/** `$schema` for a TUI theme file (hand-written from the ThemeJson type). */
export const THEME_SCHEMA_URL = `${CODE_HOME_URL}/theme.json`
