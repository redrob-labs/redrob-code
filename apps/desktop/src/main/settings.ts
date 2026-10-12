import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Settings } from "../shared/bridge"

/**
 * The app's own preferences, as one JSON file in Electron's userData directory.
 *
 * Only preferences live here. Credentials and sessions belong to the engine, and the engine's data
 * directory is shared with the CLI so both see the same sign-in and history.
 */

export const DEFAULT_SETTINGS: Settings = {
  language: "en",
  theme: "system",
  updateChannel: "stable",
  preferInstalledCli: false,
  consent: { crashReports: false, usageEvents: false, decided: false },
  recentProjects: [],
}

const MAX_RECENT = 12

/** Fills anything missing or malformed from the defaults, so an old or hand-edited file still loads. */
export function normalize(input: unknown, locale = "en"): Settings {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<Settings>
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback
  const consent = (raw.consent && typeof raw.consent === "object" ? raw.consent : {}) as Partial<Settings["consent"]>
  return {
    language: pick(raw.language, ["en", "ko"], locale.toLowerCase().startsWith("ko") ? "ko" : "en"),
    theme: pick(raw.theme, ["system", "light", "dark"], "system"),
    updateChannel: pick(raw.updateChannel, ["stable", "alpha"], "stable"),
    preferInstalledCli: raw.preferInstalledCli === true,
    consent: {
      crashReports: consent.crashReports === true,
      usageEvents: consent.usageEvents === true,
      decided: consent.decided === true,
    },
    recentProjects: Array.isArray(raw.recentProjects)
      ? [...new Set(raw.recentProjects.filter((item): item is string => typeof item === "string"))].slice(0, MAX_RECENT)
      : [],
  }
}

export function createSettingsStore(directory: string, locale: string) {
  const file = path.join(directory, "redrob-code-settings.json")
  let current = load()

  function load(): Settings {
    try {
      return normalize(JSON.parse(readFileSync(file, "utf8")), locale)
    } catch {
      return normalize({}, locale)
    }
  }

  return {
    get: () => current,
    set(patch: Partial<Settings>): Settings {
      current = normalize({ ...current, ...patch, consent: { ...current.consent, ...patch.consent } }, locale)
      mkdirSync(directory, { recursive: true })
      // Written beside and renamed over, so a crash mid-write never leaves half a file.
      const temporary = `${file}.tmp`
      writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, "utf8")
      renameSync(temporary, file)
      return current
    },
  }
}
