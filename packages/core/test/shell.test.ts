import { describe, expect, test } from "bun:test"
import path from "path"
import { Shell } from "@redrob-code/core/shell"
import { FSUtil } from "@redrob-code/core/fs-util"
import { which } from "@redrob-code/core/util/which"

const withShell = async (shell: string | undefined, fn: () => void | Promise<void>) => {
  const prev = process.env.SHELL
  if (shell === undefined) delete process.env.SHELL
  else process.env.SHELL = shell
  Shell.acceptable.reset()
  Shell.preferred.reset()
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    Shell.acceptable.reset()
    Shell.preferred.reset()
  }
}

describe("shell", () => {
  test("normalizes shell names", () => {
    expect(Shell.name("/bin/bash")).toBe("bash")
    if (process.platform === "win32") {
      expect(Shell.name("C:/tools/NU.EXE")).toBe("nu")
      expect(Shell.name("C:/tools/PWSH.EXE")).toBe("pwsh")
    }
  })

  test("detects login shells", () => {
    expect(Shell.login("/bin/bash")).toBe(true)
    expect(Shell.login("C:/tools/pwsh.exe")).toBe(false)
  })

  test("detects posix shells", () => {
    expect(Shell.posix("/bin/bash")).toBe(true)
    expect(Shell.posix("/bin/fish")).toBe(false)
    expect(Shell.posix("C:/tools/pwsh.exe")).toBe(false)
  })

  test("falls back when configured shell cannot be resolved", async () => {
    await withShell(undefined, async () => {
      const preferred = Shell.preferred()
      const acceptable = Shell.acceptable()
      expect(Shell.preferred("redrob-missing-shell")).toBe(preferred)
      expect(Shell.acceptable("redrob-missing-shell")).toBe(acceptable)
    })
  })

  test("falls back for terminal-only acceptable shells", () => {
    expect(Shell.name(Shell.acceptable("fish"))).not.toBe("fish")
    expect(Shell.name(Shell.acceptable("nu"))).not.toBe("nu")
  })

  test("builds command args per shell family", () => {
    expect(Shell.args("/bin/sh", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    expect(Shell.args("/usr/bin/fish", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    const zsh = Shell.args("/bin/zsh", "echo hi", "/tmp")
    expect(zsh[0]).toBe("-l")
    expect(zsh[1]).toBe("-c")
    expect(zsh.at(-1)).toBe("/tmp")
  })

  if (process.platform === "win32") {
    test("rejects blacklisted shells case-insensitively", async () => {
      await withShell("NU.EXE", async () => {
        expect(Shell.name(Shell.acceptable())).not.toBe("nu")
      })
    })

    test("normalizes Git Bash shell paths from env", async () => {
      const shell = "/cygdrive/c/Program Files/Git/bin/bash.exe"
      await withShell(shell, async () => {
        expect(Shell.preferred()).toBe(FSUtil.windowsPath(shell))
      })
    })

    test("resolves /usr/bin/bash from env to Git Bash", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      await withShell("/usr/bin/bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare bash to Git Bash before PATH", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      expect(Shell.acceptable("bash")).toBe(bash)
      expect(Shell.preferred("bash")).toBe(bash)
      await withShell("bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare PowerShell shells", async () => {
      const shell = which("pwsh") || which("powershell")
      if (!shell) return
      await withShell(path.win32.basename(shell), async () => {
        expect(Shell.preferred()).toBe(shell)
      })
    })
  }
})

describe("shell output encoding", () => {
  // "한글" in UTF-8 and in code page 949
  const utf8 = new TextEncoder().encode("한글 ok")
  const cp949 = new Uint8Array([0xc7, 0xd1, 0xb1, 0xdb, 0x20, 0x6f, 0x6b])

  test("env asks Python for UTF-8 on Windows only", () => {
    expect(Shell.env("win32")).toEqual({ PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" })
    expect(Shell.env("linux")).toEqual({})
    expect(Shell.env("darwin")).toEqual({})
  })

  test("utf8 prefixes PowerShell and cmd on Windows only", () => {
    expect(Shell.utf8("pwsh", "Write-Output hi", "win32")).toBe(
      "[Console]::OutputEncoding=$OutputEncoding=[Text.UTF8Encoding]::new($false);Write-Output hi",
    )
    expect(Shell.utf8("powershell", "dir", "win32")).toStartWith("[Console]::OutputEncoding=")
    expect(Shell.utf8("cmd", "echo hi", "win32")).toBe("chcp 65001>nul&echo hi")
    expect(Shell.utf8("bash", "echo hi", "win32")).toBe("echo hi")
    expect(Shell.utf8("pwsh", "echo hi", "linux")).toBe("echo hi")
    expect(Shell.utf8("/bin/bash", "echo hi", "darwin")).toBe("echo hi")
  })

  test("decoder keeps UTF-8 output as is", () => {
    const decode = Shell.decoder("win32", () => 949)
    expect(decode(utf8.subarray(0, 2)) + decode(utf8.subarray(2))).toBe("한글 ok")
  })

  test("decoder falls back to the system code page on Windows", () => {
    const decode = Shell.decoder("win32", () => 949)
    expect(decode(cp949)).toBe("한글 ok")
    expect(decode(cp949)).toBe("한글 ok")
  })

  test("decoder keeps a code page lead byte split across chunks", () => {
    // 0xc7 alone looks like the start of a UTF-8 sequence; the next chunk proves it is not
    const decode = Shell.decoder("win32", () => 949)
    expect(decode(new Uint8Array([0x61, 0xc7])) + decode(cp949.subarray(1))).toBe("a한글 ok")
  })

  test("decoder without a known code page replaces invalid bytes", () => {
    expect(Shell.decoder("win32", () => undefined)(cp949)).toBe(new TextDecoder().decode(cp949))
    expect(Shell.decoder("win32", () => 65001)(cp949)).toBe(new TextDecoder().decode(cp949))
  })

  test("decoder never switches code page off Windows", () => {
    const decode = Shell.decoder("linux", () => 949)
    expect(decode(cp949)).toBe(new TextDecoder().decode(cp949))
    expect(decode(utf8)).toBe("한글 ok")
  })
})
