import { describe, expect, test } from "bun:test"
import { chmodSync } from "node:fs"
import path from "node:path"
import type { EngineState } from "../src/shared/bridge"
import { EngineManager } from "../src/main/engine"

const fake = path.join(import.meta.dir, "fixture", "fake-engine.ts")
chmodSync(fake, 0o755)

// A shebang script stands in for the engine binary, which Windows cannot execute directly; the Windows
// path is covered by the packaged smoke test in CI instead.
describe.skipIf(process.platform === "win32")("EngineManager", () => {
  test("starts, authenticates, reports the version, and stops", async () => {
    const states: EngineState[] = []
    const engine = new EngineManager({
      binary: fake,
      source: "bundled",
      env: { ...process.env },
      onState: (state) => states.push(state),
    })
    const info = await engine.start()
    expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect((await fetch(`${info.url}/api/health`, { headers: { Authorization: info.authorization } })).status).toBe(200)
    expect((await fetch(`${info.url}/api/health`)).status).toBe(401)
    expect(states.at(-1)).toEqual({ status: "ready", url: info.url, version: "9.9.9", source: "bundled" })
    // The bundled copy is updated by the app, so it is told not to update itself.
    expect(engine.output()).toContain("client=desktop autoupdate=1")
    await engine.stop()
    expect(states.at(-1)).toEqual({ status: "stopped" })
    expect(engine.current()).toBeNull()
  })

  test("restarts after an unexpected exit", async () => {
    const states: EngineState[] = []
    const engine = new EngineManager({
      binary: fake,
      source: "cli",
      env: { ...process.env, FAKE_ENGINE_CRASH_AFTER_MS: "300" },
      maxRestarts: 1,
      onState: (state) => states.push(state),
    })
    await engine.start()
    expect(engine.output()).toContain("autoupdate=\n")
    await Bun.sleep(2_500)
    const statuses = states.map((state) => state.status)
    expect(statuses.filter((status) => status === "ready").length).toBeGreaterThanOrEqual(2)
    await engine.stop()
  }, 10_000)

  test("reports a binary that never prints the handshake", async () => {
    const states: EngineState[] = []
    const engine = new EngineManager({
      binary: "/bin/sleep",
      source: "override",
      env: { ...process.env },
      startTimeoutMs: 500,
      onState: (state) => states.push(state),
    })
    await expect(engine.start()).rejects.toThrow()
    expect(states.at(-1)?.status).toBe("failed")
  })
})
