import { $ } from "bun"
import semver from "semver"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  REDROB_CHANNEL: process.env["REDROB_CHANNEL"],
  REDROB_BUMP: process.env["REDROB_BUMP"],
  REDROB_VERSION: process.env["REDROB_VERSION"],
  REDROB_RELEASE: process.env["REDROB_RELEASE"],
}
const CHANNEL = await (async () => {
  if (env.REDROB_CHANNEL) return env.REDROB_CHANNEL
  if (env.REDROB_BUMP) return "latest"
  if (env.REDROB_VERSION && !env.REDROB_VERSION.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.REDROB_VERSION) return env.REDROB_VERSION
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  // The CLI package version is the release source of truth; `script/publish.ts` writes the
  // released version back into every package.json, so the next release bumps from here.
  const current = await Bun.file(path.resolve(import.meta.dir, "../../redrob/package.json")).json()
  const [major, minor, patch] = current.version.split(".").map((x: string) => Number(x) || 0)
  const t = env.REDROB_BUMP?.toLowerCase()
  if (t === "major") return `${major + 1}.0.0`
  if (t === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
})()

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.REDROB_RELEASE
  },
}
console.log(`redrob script`, JSON.stringify(Script, null, 2))
