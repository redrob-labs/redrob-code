import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["REDROB_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["REDROB_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("REDROB_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  REDROB_AUTO_HEAP_SNAPSHOT: truthy("REDROB_AUTO_HEAP_SNAPSHOT"),
  REDROB_GIT_BASH_PATH: process.env["REDROB_GIT_BASH_PATH"],
  /**
   * Point the console calls at a different base URL.
   *
   * Exists for verifying against a console running locally. Without it the only way to exercise a change
   * to those endpoints is to deploy it, which is how a broken `/variants/paraphrase` reached production and
   * stayed there: nothing could call it except the real thing.
   *
   * Never set in a shipped build, and it does not change where credentials come from -- a local console
   * still wants a key it recognises.
   */
  REDROB_CONSOLE_URL: process.env["REDROB_CONSOLE_URL"],
  REDROB_CONFIG: process.env["REDROB_CONFIG"],
  REDROB_CONFIG_CONTENT: process.env["REDROB_CONFIG_CONTENT"],
  REDROB_DISABLE_AUTOUPDATE: truthy("REDROB_DISABLE_AUTOUPDATE"),
  REDROB_ALWAYS_NOTIFY_UPDATE: truthy("REDROB_ALWAYS_NOTIFY_UPDATE"),
  REDROB_DISABLE_PRUNE: truthy("REDROB_DISABLE_PRUNE"),
  REDROB_DISABLE_TERMINAL_TITLE: truthy("REDROB_DISABLE_TERMINAL_TITLE"),
  REDROB_SHOW_TTFD: truthy("REDROB_SHOW_TTFD"),
  REDROB_DISABLE_AUTOCOMPACT: truthy("REDROB_DISABLE_AUTOCOMPACT"),
  REDROB_DISABLE_MODELS_FETCH: truthy("REDROB_DISABLE_MODELS_FETCH"),
  REDROB_DISABLE_MOUSE: truthy("REDROB_DISABLE_MOUSE"),
  REDROB_FAKE_VCS: process.env["REDROB_FAKE_VCS"],
  REDROB_SERVER_PASSWORD: process.env["REDROB_SERVER_PASSWORD"],
  REDROB_SERVER_USERNAME: process.env["REDROB_SERVER_USERNAME"],
  REDROB_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("REDROB_DISABLE_FFF"),

  // Experimental
  REDROB_EXPERIMENTAL_FILEWATCHER: Config.boolean("REDROB_EXPERIMENTAL_FILEWATCHER").pipe(Config.withDefault(false)),
  REDROB_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("REDROB_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  REDROB_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("REDROB_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  REDROB_DB: process.env["REDROB_DB"],

  REDROB_WORKSPACE_ID: process.env["REDROB_WORKSPACE_ID"],
  REDROB_EXPERIMENTAL_WORKSPACES: enabledByExperimental("REDROB_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get REDROB_DISABLE_PROJECT_CONFIG() {
    return truthy("REDROB_DISABLE_PROJECT_CONFIG")
  },
  get REDROB_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("REDROB_EXPERIMENTAL_REFERENCES")
  },
  get REDROB_TUI_CONFIG() {
    return process.env["REDROB_TUI_CONFIG"]
  },
  get REDROB_CONFIG_DIR() {
    return process.env["REDROB_CONFIG_DIR"]
  },
  get REDROB_PURE() {
    return truthy("REDROB_PURE")
  },
  get REDROB_PERMISSION() {
    return process.env["REDROB_PERMISSION"]
  },
  get REDROB_PLUGIN_META_FILE() {
    return process.env["REDROB_PLUGIN_META_FILE"]
  },
  // Tri-state: undefined means "no preference", so the caller's default applies.
  get REDROB_PLUGIN_TYPES() {
    return process.env["REDROB_PLUGIN_TYPES"] === undefined ? undefined : truthy("REDROB_PLUGIN_TYPES")
  },
  get REDROB_PLUGIN_TYPES_PACKAGE() {
    return process.env["REDROB_PLUGIN_TYPES_PACKAGE"]
  },
  get REDROB_CLIENT() {
    return process.env["REDROB_CLIENT"] ?? "cli"
  },
}
