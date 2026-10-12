#!/usr/bin/env bun
/**
 * Development: the interface from Vite with hot reload, the main process rebuilt once, Electron on top.
 *
 * The engine comes from REDROB_CODE_BIN when set, else this checkout's release build
 * (packages/redrob/dist), else an installed CLI. `http://localhost:<port>` is on the engine's CORS
 * allowlist, so the dev page talks to it the same way the packaged `oc://renderer` page does.
 */
import { spawn } from "node:child_process"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const studio = path.resolve(root, "..", "studio")
const port = Number(process.env["REDROB_CODE_STUDIO_PORT"] ?? 5173)
const url = `http://localhost:${port}`

const vite = spawn("bun", ["run", "dev", "--port", String(port), "--strictPort"], { cwd: studio, stdio: "inherit" })
const build = Bun.spawnSync(["bun", "run", path.join(root, "script", "build.ts")], {
  stdio: ["inherit", "inherit", "inherit"],
})
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)

for (let i = 0; i < 100; i++) {
  const ready = await fetch(url).then(
    (response) => response.ok,
    () => false,
  )
  if (ready) break
  await Bun.sleep(200)
}

const electron = (await import("electron")).default as unknown as string
const app = spawn(electron, [root], { stdio: "inherit", env: { ...process.env, REDROB_CODE_STUDIO_URL: url } })
app.once("exit", (code) => {
  vite.kill()
  process.exit(code ?? 0)
})
