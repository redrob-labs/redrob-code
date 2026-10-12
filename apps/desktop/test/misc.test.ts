import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { installCommand } from "../src/main/cli"
import { parseStatus } from "../src/main/git"
import { resolveRendererFile } from "../src/main/renderer-protocol"
import { normalize } from "../src/main/settings"
import { parseEnv } from "../src/main/shell-env"

test("the renderer protocol never serves a file outside the bundle", () => {
  const root = "/app/studio"
  const exists = (file: string) => file === "/app/studio/assets/a.js" || file === "/app/studio/index.html"
  expect(resolveRendererFile(root, "oc://renderer/assets/a.js", exists)).toBe("file:///app/studio/assets/a.js")
  expect(resolveRendererFile(root, "oc://renderer/sessions/123", exists)).toBe("file:///app/studio/index.html")
  // URL parsing already collapses dot segments at the root, so this one stays inside the bundle...
  expect(resolveRendererFile(root, "oc://renderer/%2e%2e/%2e%2e/etc/passwd", exists)).toStartWith("file:///app/studio/")
  // ...and an encoded slash, which survives URL parsing and only becomes `../` once decoded, is refused.
  expect(resolveRendererFile(root, "oc://renderer/..%2f..%2fetc%2fpasswd", exists)).toBeNull()
  expect(resolveRendererFile(root, "oc://elsewhere/index.html", exists)).toBeNull()
})

test("settings default to sending nothing, and repair a bad file", () => {
  const settings = normalize(
    { consent: { crashReports: "yes" }, theme: "neon", recentProjects: ["/a", "/a", 3] },
    "ko-KR",
  )
  expect(settings.consent).toEqual({ crashReports: false, usageEvents: false, decided: false })
  expect(settings.theme).toBe("system")
  expect(settings.language).toBe("ko")
  expect(settings.recentProjects).toEqual(["/a"])
})

test("the install button runs the official installer, nothing else", () => {
  expect(installCommand("win32").display).toBe("irm https://console.redrob.ai/code/install.ps1 | iex")
  expect(installCommand("linux").display).toBe("curl -fsSL https://console.redrob.ai/code/install.sh | sh")
})

test("parses porcelain status, including renames and untracked files", () => {
  const output = [" M src/a.ts", "?? new.ts", "R  new-name.ts", "old-name.ts", "D  gone.ts", "A  added.ts", ""].join(
    "\0",
  )
  expect(parseStatus(output)).toEqual([
    { path: "src/a.ts", status: "modified" },
    { path: "new.ts", status: "untracked" },
    { path: "new-name.ts", status: "renamed" },
    { path: "gone.ts", status: "deleted" },
    { path: "added.ts", status: "added" },
  ])
})

test("parses a NUL-separated environment", () => {
  expect(parseEnv("PATH=/usr/bin:/bin\0EMPTY=\0A=b=c\0REDROB_CODE_RESOLVING_ENV=1\0")).toEqual({
    PATH: "/usr/bin:/bin",
    EMPTY: "",
    A: "b=c",
  })
})

test("desktop artifact names can never match what the CLI installer downloads", () => {
  // install looks for `redrob-$target$archive_ext` with APP=redrob; release.yml also publishes
  // redrob-code-x64-setup.exe. Every desktop artifact starts `redrob-code-desktop-`.
  const config = readFileSync(path.resolve(import.meta.dir, "../electron-builder.config.mjs"), "utf8")
  expect(config).toContain('artifactName: "redrob-code-desktop-${version}-${os}-${arch}.${ext}"')
  const install = readFileSync(path.resolve(import.meta.dir, "../../../install"), "utf8")
  expect(install).toContain("APP=redrob")
  expect(install).toContain('filename="$APP-$target$archive_ext"')
  const cliTargets = /^redrob-(linux|darwin|windows)-(x64|arm64)(-baseline)?(-musl)?\.(zip|tar\.gz)$/
  for (const name of [
    "redrob-code-desktop-0.4.0-win-x64.exe",
    "redrob-code-desktop-0.4.0-linux-x86_64.AppImage",
    "redrob-code-desktop-0.4.0-mac-arm64.dmg",
  ]) {
    expect(cliTargets.test(name)).toBe(false)
    expect(name).not.toBe("redrob-code-x64-setup.exe")
  }
})
