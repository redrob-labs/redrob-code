import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * The Windows installer definition, guarded on the four properties that are the reason it exists
 * rather than on its text.
 *
 * These are all silent failures in the field: nothing here breaks a build, and every one of them
 * only shows up as a user with a UAC prompt they should not have seen, a PATH they cannot use, or a
 * binary that cannot upgrade itself. A CI check is the only place they get caught.
 */
const definition = fs.readFileSync(
  path.join(import.meta.dir, "..", "..", "..", "..", "installer", "windows", "redrob-code.iss"),
  "utf8",
)

describe("the Windows installer definition", () => {
  test("asks for no elevation and installs per-user", () => {
    // `lowest` is what keeps a UAC prompt off a per-user CLI install. Anything else and every
    // update needs an administrator, and a non-admin cannot repair their own install.
    expect(definition).toContain("PrivilegesRequired=lowest")
    expect(definition).toContain("DefaultDirName={localappdata}\\Redrob\\bin")
    // `{autopf}` and `{pf}` both resolve under Program Files, which needs elevation.
    expect(definition).not.toMatch(/DefaultDirName=\{(auto)?pf/)
  })

  test("touches only the user's PATH, never the machine's", () => {
    expect(definition).toContain("Root: HKCU")
    // HKLM's Environment key is the machine PATH. A per-user installer writing there is both a
    // permissions failure and shared state it does not own.
    expect(definition).not.toContain("HKLM")
  })

  test("installs both names the other platforms install", () => {
    // install.sh writes `redrob` and `redrob-code` as one hard-linked file. Windows has no hard
    // link here, so it is two copies -- but a script that works on macOS must not fail here
    // because only one of the two names exists.
    expect(definition).toContain('DestName: "redrob.exe"')
    expect(definition).toContain('DestName: "redrob-code.exe"')
  })

  test("removes its PATH entry when uninstalled", () => {
    // Inno does not undo a registry append on uninstall. Without this the uninstaller leaves a
    // segment pointing at a directory it just deleted, and they accumulate one per cycle.
    expect(definition).toContain("procedure CurUninstallStepChanged")
    expect(definition).toContain("RemoveFromUserPath")
  })

  test("does not let the user relocate the install", () => {
    // `isWindowsInstallerInstall` recognises the install by directory. A user who moves it gets a
    // binary that reports `unknown` and refuses to upgrade, so the choice is not offered.
    expect(definition).toContain("DisableDirPage=yes")
  })

  test("produces the asset name the release and the console both expect", () => {
    expect(definition).toContain("OutputBaseFilename=redrob-code-x64-setup")
  })
})
