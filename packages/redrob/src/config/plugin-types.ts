export * as ConfigPluginTypes from "./plugin-types"

import { Flag } from "@redrob-code/core/flag/flag"
import { InstallationLocal, InstallationVersion } from "@redrob-code/core/installation/version"

// redrob installs its plugin typings package into every config directory it reads so that plugins
// referenced from `redrob.json` can `import type { Plugin } from "@redrob-code/plugin"` and resolve
// real types. That package is not on the public npm registry yet, so an unconditional install 404s
// on every startup and the only visible effect is a warning in the log. Keep it opt-in until the
// package is published, then flip DEFAULT_ENABLED to true.
//
// REDROB_PLUGIN_TYPES=1 enables the default package early. REDROB_PLUGIN_TYPES_PACKAGE installs a
// different package instead (for example a private mirror), resolved at its latest version since
// only the first-party package tracks the CLI version.
const DEFAULT_ENABLED = false
const DEFAULT_PACKAGE = "@redrob-code/plugin"

// The dependency to add to a config directory, or undefined when the install should be skipped.
// Local (from-source) runs always skip: the workspace already provides the typings and the registry
// has no matching version for them.
export function dependency() {
  if (InstallationLocal) return undefined
  if (Flag.REDROB_PLUGIN_TYPES_PACKAGE) return { name: Flag.REDROB_PLUGIN_TYPES_PACKAGE, version: undefined }
  if (!(Flag.REDROB_PLUGIN_TYPES ?? DEFAULT_ENABLED)) return undefined
  return { name: DEFAULT_PACKAGE, version: InstallationVersion }
}
