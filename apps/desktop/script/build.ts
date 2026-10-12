#!/usr/bin/env bun
/**
 * Builds the main process and the preload into `out/`.
 *
 * Everything is bundled into two files with only `electron` left external, so the packaged app has no
 * `node_modules` to collect. That is deliberate: electron-builder's dependency walker and a bun
 * workspace's hoisted layout disagree, and a bundle sidesteps the question entirely.
 *
 * The preload is CommonJS because a sandboxed preload cannot load an ES module.
 */
import { rm } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const out = path.join(root, "out")
await rm(out, { recursive: true, force: true })

const version = process.env["REDROB_VERSION"] ?? "0.0.0"
const common = {
  target: "node" as const,
  external: ["electron"],
  minify: false,
  sourcemap: "linked" as const,
  define: { "process.env.REDROB_CODE_DESKTOP_VERSION": JSON.stringify(version) },
}

const builds = [
  { entry: "src/main/index.ts", format: "esm" as const, naming: "main.js" },
  { entry: "src/preload/index.ts", format: "cjs" as const, naming: "preload.cjs" },
]

for (const build of builds) {
  const result = await Bun.build({
    ...common,
    entrypoints: [path.join(root, build.entry)],
    outdir: out,
    format: build.format,
    naming: build.naming,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
}
console.log(`built ${builds.map((b) => b.naming).join(", ")} into ${path.relative(process.cwd(), out) || "out"}`)
