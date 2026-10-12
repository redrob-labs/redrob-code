import { existsSync } from "node:fs"
import path from "node:path"

/** The engine binary for integration tests: REDROB_CODE_ENGINE, else this checkout's release build. */
export function engineBinary() {
  const os = process.platform === "win32" ? "windows" : process.platform
  const exe = process.platform === "win32" ? "redrob.exe" : "redrob"
  const local = path.resolve(import.meta.dir, "../../../redrob/dist", `redrob-${os}-${process.arch}`, "bin", exe)
  const binary = process.env["REDROB_CODE_ENGINE"] ?? local
  return existsSync(binary) ? binary : null
}

/** An environment that keeps the engine's data, config and caches inside `home`, offline. */
export function engineEnv(home: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    LOCALAPPDATA: path.join(home, "local"),
    APPDATA: path.join(home, "roaming"),
    REDROB_DISABLE_MODELS_FETCH: "1",
    REDROB_DISABLE_AUTOUPDATE: "1",
    REDROB_API_KEY: "",
  }
}

/** Starts `redrob serve` with its own data directories, waits for the handshake, returns url + auth. */
export async function startEngine(binary: string, home: string) {
  const password = "contest-test"
  const child = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    env: { ...engineEnv(home), REDROB_SERVER_PASSWORD: password },
    stdout: "pipe",
    stderr: "ignore",
  })
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let output = ""
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    output += decoder.decode(value)
    const url = /redrob server listening on (http\S+)/.exec(output)?.[1]
    if (url) {
      reader.releaseLock()
      return { url, authorization: `Basic ${btoa(`redrob:${password}`)}`, stop: () => child.kill() }
    }
  }
  child.kill()
  throw new Error(`engine did not start: ${output}`)
}
