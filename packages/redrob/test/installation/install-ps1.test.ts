import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * `install.ps1`, the Windows one-liner (`irm .../install.ps1 | iex`).
 *
 * Nothing builds or runs it in CI, so these guard the properties that only fail on a user's PC:
 * a script `iex` cannot run, a window closed by `exit`, an asset name the release does not publish,
 * an install folder Redrob Desktop does not look in, or text Windows PowerShell 5.1 misreads.
 */
const file = path.join(import.meta.dir, "..", "..", "..", "..", "install.ps1")
const script = fs.readFileSync(file, "utf8")
// Comments say what the code must not do, so the code checks look at code lines only.
const code = script
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n")

describe("install.ps1", () => {
  test("runs through iex: no param block, no exit", () => {
    // `irm ... | iex` cannot bind a param() block, so options come from $args and the environment.
    expect(code).not.toMatch(/^\s*param\s*\(/im)
    // `exit` inside `iex` closes the PowerShell window the person typed the command into.
    expect(code).not.toMatch(/\bexit\b/i)
    // One scriptblock, so `iex` leaves no variables in the person's session.
    expect(code.trimStart().startsWith("& {")).toBe(true)
    expect(code.trimEnd().endsWith("} @args")).toBe(true)
  })

  test("is ASCII, which Windows PowerShell 5.1 reads the same in every code page", () => {
    expect([...script].every((ch) => ch.charCodeAt(0) < 128)).toBe(true)
  })

  test("installs where Redrob Desktop and `redrob upgrade` look", () => {
    // redrob-desktop's enginesetup.rs: `~/.redrob/bin/redrob.exe`; isCurlInstall: a `.redrob\bin` dir.
    expect(code).toContain("Join-Path $env:USERPROFILE '.redrob\\bin'")
    expect(code).toContain("'redrob.exe', 'redrob-code.exe'")
  })

  test("reads its options from the environment, under the names both installers use", () => {
    for (const name of [
      "REDROB_VERSION",
      "REDROB_CODE_VERSION",
      "REDROB_INSTALL_DIR",
      "REDROB_CODE_INSTALL_DIR",
      "REDROB_CODE_DOWNLOAD_BASE",
      "REDROB_NO_MODIFY_PATH",
      "REDROB_CONNECT",
    ]) {
      expect(code).toContain(`'${name}'`)
    }
  })

  test("downloads assets the release publishes and verifies them", () => {
    // The release workflow zips `dist/redrob-windows-*` (x64, x64-baseline, arm64) and publishes
    // SHA256SUMS.txt covering every asset.
    expect(code).toContain('"redrob-windows-$arch"')
    expect(code).toContain('"$asset-baseline"')
    expect(code).toContain("'SHA256SUMS.txt'")
    expect(code).toContain("Get-FileHash")
    expect(code).toContain("/latest/download/VERSION")
  })

  test("changes only the user's PATH", () => {
    expect(code).toContain("[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)")
    expect(code).not.toContain("LocalMachine")
    expect(code).not.toMatch(/HKLM/i)
  })

  const pwsh = Bun.which("pwsh")
  test.skipIf(!pwsh)("parses in PowerShell", () => {
    const result = Bun.spawnSync([
      pwsh!,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { $_.ToString() }; exit 1 }`,
    ])
    expect(result.stdout.toString() + result.stderr.toString()).toBe("")
    expect(result.exitCode).toBe(0)
  })
})
