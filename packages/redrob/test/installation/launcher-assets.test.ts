import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"
import {
  MANIFEST,
  MANIFEST_NAME,
  STEM,
  TARGETS,
  expectedLauncherAssets,
  isLauncherAssetName,
  launcherAssetName,
  manifestText,
  pack,
  verifyReleaseDirectory,
  writeManifest,
} from "../../script/launcher-assets"

/**
 * Redrob Launcher installs an asset only when its name is `<stem>-<version>-<os>-<arch>[-portable].<ext>`
 * with a token from a fixed list. The build's own names (`redrob-linux-x64.tar.gz`) do not parse, so
 * every release before this check shipped nothing the launcher could install -- silently, because
 * the release workflow was green. This pins the names the publish job adds and the layout inside.
 */
describe("launcher asset names", () => {
  test("every produced name is one the launcher parses", () => {
    for (const name of expectedLauncherAssets("0.5.1")) {
      expect(isLauncherAssetName(name)).toBe(true)
    }
    expect(expectedLauncherAssets("0.5.1").sort()).toEqual(
      [
        "redrob-code-0.5.1-linux-x86_64.tar.gz",
        "redrob-code-0.5.1-linux-aarch64.tar.gz",
        "redrob-code-0.5.1-macos-aarch64-portable.zip",
        "redrob-code-0.5.1-macos-x86_64-portable.zip",
        "redrob-code-0.5.1-windows-x64-portable.zip",
        "redrob-code-0.5.1-windows-arm64-portable.zip",
      ].sort(),
    )
  })

  test("a prerelease version survives the right-to-left split", () => {
    expect(isLauncherAssetName(launcherAssetName("0.6.0-rc.1", "linux-x86_64", "tar.gz"))).toBe(true)
  })

  test("the build's own names and the wrong spellings do not parse", () => {
    for (const bad of [
      "redrob-linux-x64.tar.gz", // no version, stem `redrob`
      "redrob-darwin-arm64.zip",
      "redrob-code-0.5.1-windows-x64-setup.exe", // the launcher does not install an exe
      "redrob-code-v0.5.1-linux-x86_64.tar.gz", // leading v
      "redrob-code-0.5.1-linux-x64.tar.gz", // x64 is not a linux token
      "redrob-code-0.5.1-linux-amd64.tar.gz",
      "redrob-code-0.5.1-darwin-arm64-portable.zip", // darwin, arm64 are not macOS tokens
      "redrob-code-0.5.1-macos-arm64.zip", // a plain zip is not a package kind
      "redrob-code-0.5.1-win-x64-portable.zip",
    ]) {
      expect(isLauncherAssetName(bad)).toBe(false)
    }
  })

  // The publish job runs the packer on ubuntu only, and that is the only place it is meant to run:
  // Windows' tar does not take the same symlink and a user-mode symlink needs a privilege the
  // runner does not hold. The name tests above still run everywhere.
  const unix = test.skipIf(process.platform === "win32")

  unix("packs a launcher tarball with bin/redrob-code and copies the signed zips", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-assets-"))
    try {
      const unsigned = path.join(root, "unsigned")
      const signed = path.join(root, "signed")
      const out = path.join(root, "out")
      for (const [dir, target] of Object.entries(TARGETS)) {
        if (target.kind === "tar.gz") {
          fs.mkdirSync(path.join(unsigned, dir, "bin"), { recursive: true })
          fs.writeFileSync(path.join(unsigned, dir, "bin", "redrob"), `#!/bin/sh\necho ${dir}\n`)
        } else {
          fs.mkdirSync(signed, { recursive: true })
          fs.writeFileSync(path.join(signed, `${dir}.zip`), `zip:${dir}`)
        }
      }

      const names = await pack({ version: "0.5.1", unsigned, signed, out })
      expect(names.sort()).toEqual(expectedLauncherAssets("0.5.1").sort())
      expect(fs.readdirSync(out).sort()).toEqual([...expectedLauncherAssets("0.5.1"), MANIFEST_NAME].sort())
      expect(fs.readFileSync(path.join(out, MANIFEST_NAME), "utf8")).toBe(manifestText())
      expect(verifyReleaseDirectory(out, "0.5.1")).toEqual([])

      // The launcher unpacks into a single top folder and looks for `bin/<app-id>`.
      const listing = await $`tar -tzvf ${path.join(out, "redrob-code-0.5.1-linux-x86_64.tar.gz")}`.text()
      expect(listing).toContain(`redrob-code-0.5.1-linux-x86_64/bin/${STEM}`)
      expect(listing).toMatch(/redrob-code-0\.5\.1-linux-x86_64\/bin\/redrob -> redrob-code/)
      expect(listing).toMatch(/^-rwxr-xr-x .* redrob-code-0\.5\.1-linux-x86_64\/bin\/redrob-code$/m)

      // The signed archive is the asset, unchanged: the notarized bytes are what gets installed.
      expect(fs.readFileSync(path.join(out, "redrob-code-0.5.1-macos-aarch64-portable.zip"), "utf8")).toBe(
        "zip:redrob-darwin-arm64",
      )
      expect(fs.readFileSync(path.join(out, "redrob-code-0.5.1-windows-arm64-portable.zip"), "utf8")).toBe(
        "zip:redrob-windows-arm64",
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * `redrob-launcher.json` is how the launcher learns, without a launcher release, that this release
   * reads its shared account file and which asset is its icon (the launcher's `docs/release-manifest.md`).
   * Exactly `{ "schema": 1, "sharedAccount": true, "icon": "redrob-code.png" }`: a wrong schema is
   * ignored by the launcher and a false flag hides the sign-in, both silently, so the bytes are pinned here.
   */
  describe("release manifest", () => {
    test("is the launcher contract, verbatim", () => {
      expect(MANIFEST_NAME).toBe("redrob-launcher.json")
      expect(manifestText()).toBe('{ "schema": 1, "sharedAccount": true, "icon": "redrob-code.png" }\n')
      const parsed = JSON.parse(manifestText())
      expect(parsed).toEqual({ schema: 1, sharedAccount: true, icon: "redrob-code.png" })
      expect(parsed.schema).toBe(1)
      expect(parsed.sharedAccount).toBe(true)
      expect(MANIFEST).toEqual({ schema: 1, sharedAccount: true, icon: "redrob-code.png" })
    })

    test("a release directory without it fails the check", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-manifest-"))
      try {
        for (const name of expectedLauncherAssets("0.5.1")) fs.writeFileSync(path.join(root, name), name)
        expect(verifyReleaseDirectory(root, "0.5.1")).toEqual([`missing ${MANIFEST_NAME}`])

        writeManifest(root)
        expect(verifyReleaseDirectory(root, "0.5.1")).toEqual([])

        fs.writeFileSync(path.join(root, MANIFEST_NAME), '{ "schema": 2, "sharedAccount": false }\n')
        expect(verifyReleaseDirectory(root, "0.5.1")).toEqual([
          `${MANIFEST_NAME} schema is 2, expected 1`,
          `${MANIFEST_NAME} sharedAccount is false, expected true`,
        ])

        fs.writeFileSync(path.join(root, MANIFEST_NAME), "not json")
        expect(verifyReleaseDirectory(root, "0.5.1")[0]).toMatch(/is not JSON/)

        fs.rmSync(path.join(root, "redrob-code-0.5.1-linux-x86_64.tar.gz"))
        writeManifest(root)
        expect(verifyReleaseDirectory(root, "0.5.1")).toEqual([
          "missing launcher asset redrob-code-0.5.1-linux-x86_64.tar.gz",
        ])
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  })

  unix("refuses to pack when a platform's build output is missing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-assets-"))
    try {
      await expect(
        pack({ version: "0.5.1", unsigned: path.join(root, "nope"), signed: root, out: path.join(root, "out") }),
      ).rejects.toThrow(/missing build output/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
