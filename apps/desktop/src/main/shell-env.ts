import { execFileSync } from "node:child_process"

/**
 * The person's login-shell environment, for an app launched from the Dock or a desktop entry.
 *
 * A GUI app on macOS and Linux starts with a minimal PATH, so the engine would not find `git`, `node`,
 * `bun` or anything installed by a version manager, and every shell command the agent runs would fail
 * in ways that look like the project's fault. Windows GUI apps inherit the user's PATH already.
 */
export function loadShellEnv(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Record<string, string> {
  if (platform === "win32") return {}
  const shell = env["SHELL"] || (platform === "darwin" ? "/bin/zsh" : "/bin/bash")
  const marker = "__REDROB_CODE_ENV__"
  try {
    const output = execFileSync(shell, ["-ilc", `printf '${marker}'; env -0`], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...env, REDROB_CODE_RESOLVING_ENV: "1" },
    })
    return parseEnv(output.slice(output.indexOf(marker) + marker.length))
  } catch {
    return {}
  }
}

export function parseEnv(output: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const entry of output.split("\0")) {
    const index = entry.indexOf("=")
    if (index <= 0) continue
    result[entry.slice(0, index)] = entry.slice(index + 1)
  }
  delete result["REDROB_CODE_RESOLVING_ENV"]
  return result
}
