import { describe, expect, test } from "bun:test"
import { cliCandidates, findCli, releaseTarget, resolveEngineBinary } from "../src/main/engine-binary"

const base = {
  arch: "x64",
  home: "/home/a",
  resourcesPath: "/opt/app/resources",
  repoRoot: null,
  preferInstalledCli: false,
}

const only =
  (...files: string[]) =>
  (file: string) =>
    files.includes(file)

describe("resolveEngineBinary", () => {
  test("an explicit override wins", () => {
    const resolved = resolveEngineBinary({
      ...base,
      platform: "linux",
      env: { REDROB_CODE_BIN: "/x/redrob", PATH: "/usr/bin" },
      exists: only("/x/redrob", "/opt/app/resources/engine/redrob"),
    })
    expect(resolved).toEqual({ binary: "/x/redrob", source: "override" })
  })

  test("the bundled engine is the default, even when a CLI is installed", () => {
    const resolved = resolveEngineBinary({
      ...base,
      platform: "linux",
      env: { PATH: "" },
      exists: only("/home/a/.redrob/bin/redrob", "/opt/app/resources/engine/redrob"),
    })
    expect(resolved).toEqual({ binary: "/opt/app/resources/engine/redrob", source: "bundled" })
  })

  test("an installed CLI is used first only when the person asked for it", () => {
    const resolved = resolveEngineBinary({
      ...base,
      platform: "linux",
      preferInstalledCli: true,
      env: { PATH: "" },
      exists: only("/home/a/.redrob/bin/redrob", "/opt/app/resources/engine/redrob"),
    })
    expect(resolved).toEqual({ binary: "/home/a/.redrob/bin/redrob", source: "cli" })
  })

  test("Windows bundles redrob.bin so the signed exe is not signed twice", () => {
    const resolved = resolveEngineBinary({
      ...base,
      platform: "win32",
      resourcesPath: "C:\\App\\resources",
      env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", Path: "" },
      exists: only("C:\\App\\resources\\engine\\redrob.bin"),
    })
    expect(resolved).toEqual({ binary: "C:\\App\\resources\\engine\\redrob.bin", source: "bundled" })
  })

  test("an unpackaged checkout uses its own release build", () => {
    const resolved = resolveEngineBinary({
      ...base,
      platform: "linux",
      resourcesPath: null,
      repoRoot: "/src/redrob-code",
      env: { PATH: "" },
      exists: only("/src/redrob-code/packages/redrob/dist/redrob-linux-x64/bin/redrob"),
    })
    expect(resolved?.source).toBe("bundled")
  })

  test("with nothing bundled it falls back to an installed CLI, then to nothing", () => {
    const env = { PATH: "/usr/local/bin" }
    expect(resolveEngineBinary({ ...base, platform: "linux", env, exists: only("/usr/local/bin/redrob") })).toEqual({
      binary: "/usr/local/bin/redrob",
      source: "cli",
    })
    expect(resolveEngineBinary({ ...base, platform: "linux", env, exists: () => false })).toBeNull()
  })
})

describe("cli locations", () => {
  test("follow install's order on macOS and Linux", () => {
    const list = cliCandidates({ platform: "darwin", home: "/Users/a", env: { XDG_BIN_DIR: "/xdg", PATH: "" } })
    expect(list.slice(0, 4)).toEqual([
      "/xdg/redrob",
      "/Users/a/bin/redrob",
      "/Users/a/.redrob/bin/redrob",
      "/Users/a/.local/bin/redrob",
    ])
  })

  test("include the Windows installer's fixed directory", () => {
    const found = findCli({
      platform: "win32",
      home: "C:\\Users\\a",
      env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", Path: "" },
      exists: only("C:\\Users\\a\\AppData\\Local\\Redrob\\bin\\redrob.exe"),
    })
    expect(found).toBe("C:\\Users\\a\\AppData\\Local\\Redrob\\bin\\redrob.exe")
  })

  test("release targets match packages/redrob/script/build.ts", () => {
    expect(releaseTarget("win32", "x64")).toBe("redrob-windows-x64")
    expect(releaseTarget("darwin", "arm64")).toBe("redrob-darwin-arm64")
  })
})
