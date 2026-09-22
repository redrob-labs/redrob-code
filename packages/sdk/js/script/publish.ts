#!/usr/bin/env bun

import { Script } from "@redrob-code/script"
import { $ } from "bun"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

const originalText = await Bun.file("package.json").text()
const pkg = JSON.parse(originalText) as {
  name: string
  version: string
  exports: Record<string, unknown>
}
/*
  The version comes from the RELEASE, not from the committed literal.

  `package.json` holds `0.0.0` on purpose: this package is generated from the CLI's own API surface, so a
  version committed here would be a second number to remember to bump and would drift from the CLI it
  describes. `Script.version` is the figure the release computed, which also makes an SDK version answerable
  -- a consumer can tell which CLI a given SDK build was generated from.

  Falls back to whatever is in the file, so running this script outside a release still does something
  predictable rather than publishing `undefined`.
*/
const version = Script.version || pkg.version
pkg.version = version
function transformExports(exports: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(exports).map(([key, value]) => {
      if (typeof value === "string") {
        const file = value.replace("./src/", "./dist/").replace(".ts", "")
        return [key, { import: file + ".js", types: file + ".d.ts" }]
      }
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return [key, transformExports(value)]
      }
      return [key, value]
    }),
  )
}
if (await published(pkg.name, version)) {
  console.log(`already published ${pkg.name}@${version}`)
} else {
  console.log(`publishing ${pkg.name}@${version} on tag ${Script.channel}`)
  pkg.exports = transformExports(pkg.exports)
  await Bun.write("package.json", JSON.stringify(pkg, null, 2))
  try {
    await $`bun pm pack`
    await $`npm publish *.tgz --tag ${Script.channel} --access public`
  } finally {
    /* The committed 0.0.0 and the untransformed exports go back, so a release leaves no diff behind. */
    await Bun.write("package.json", originalText)
  }
}
