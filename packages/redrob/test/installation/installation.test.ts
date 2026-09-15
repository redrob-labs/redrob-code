import { describe, expect, test } from "bun:test"
import { makeGlobalNode } from "@redrob-code/core/effect/app-node"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { httpClient } from "@redrob-code/core/effect/app-node-platform"
import { Effect, Exit, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationChannel } from "@redrob-code/core/installation/version"
import { CrossSpawnSpawner } from "@redrob-code/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { CDN_VERSION_NAME } from "../../script/cdn"
import path from "path"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(
  handler: (
    cmd: string,
    args: readonly string[],
    env: Record<string, string | undefined>,
  ) => string | { code: number; stdout?: string; stderr?: string } = () => "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [], std?.options.env ?? {})
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function textResponse(body: string) {
  return new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (
    cmd: string,
    args: readonly string[],
    env: Record<string, string | undefined>,
  ) => string | { code: number; stdout?: string; stderr?: string },
) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(spawnHandler),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttpClient(httpHandler)],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

describe("installation", () => {
  describe("latest", () => {
    const cdnCalls: string[] = []
    testEffect(
      testLayer((request) => {
        cdnCalls.push(request.url)
        return textResponse("1.2.3\n")
      }),
    ).effect("reads the version marker the CDN publishes for a curl install", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("curl")
        expect(result).toBe("1.2.3")
        // The bucket install.sh downloads from, and nothing else: GitHub Releases are unreadable on
        // a private repository, so asking for one would be a 404 dressed up as an update check.
        expect(cdnCalls).toEqual([`${Installation.CDN_DOWNLOAD_BASE}/latest/${Installation.CDN_VERSION_FILE}`])
        expect(cdnCalls.some((url) => url.includes("api.github.com"))).toBe(false)
      }),
    )

    const unknownCalls: string[] = []
    testEffect(
      testLayer((request) => {
        unknownCalls.push(request.url)
        return textResponse("1.4.0")
      }),
    ).effect("reads the same marker for an install it could not place", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("unknown")
        expect(result).toBe("1.4.0")
        expect(unknownCalls).toEqual([`${Installation.CDN_DOWNLOAD_BASE}/latest/${Installation.CDN_VERSION_FILE}`])
        expect(unknownCalls.some((url) => url.includes("api.github.com"))).toBe(false)
      }),
    )

    testEffect(testLayer(() => textResponse("v4.0.0-beta.1\n"))).effect("strips a v prefix from the marker", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("curl")
        expect(result).toBe("4.0.0-beta.1")
      }),
    )

    testEffect(testLayer(() => new Response("<html>404</html>", { status: 200 }))).effect(
      "refuses a marker that does not name a version",
      () =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(Installation.use.latest("curl"))
          expect(Exit.isFailure(exit)).toBe(true)
        }),
    )

    test("asks for the key the publish script actually writes", () => {
      expect(Installation.CDN_VERSION_FILE).toBe(CDN_VERSION_NAME)
      expect(Installation.cdnVersionUrl({})).toBe(`${Installation.CDN_DOWNLOAD_BASE}/latest/${CDN_VERSION_NAME}`)
      // A self-hosted bucket is the one install.sh was pointed at, so it is the one asked for here.
      expect(Installation.cdnVersionUrl({ REDROB_CODE_DOWNLOAD_BASE: "https://example.com/builds/" })).toBe(
        `https://example.com/builds/latest/${CDN_VERSION_NAME}`,
      )
    })

    const npmCalls: string[] = []
    testEffect(
      testLayer((request) => {
        npmCalls.push(request.url)
        return jsonResponse({ version: "1.5.0" })
      }),
    ).effect("reads npm versions via registry", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("npm")
        expect(result).toBe("1.5.0")
        expect(npmCalls).toContain(`https://registry.npmjs.org/redrob-code/${InstallationChannel}`)
      }),
    )

    const bunCalls: string[] = []
    testEffect(
      testLayer((request) => {
        bunCalls.push(request.url)
        return jsonResponse({ version: "1.6.0" })
      }),
    ).effect("reads bun versions via registry", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("bun")
        expect(result).toBe("1.6.0")
        expect(bunCalls).toContain(`https://registry.npmjs.org/redrob-code/${InstallationChannel}`)
      }),
    )

    const pnpmCalls: string[] = []
    testEffect(
      testLayer((request) => {
        pnpmCalls.push(request.url)
        return jsonResponse({ version: "1.7.0" })
      }),
    ).effect("reads pnpm versions via registry", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("pnpm")
        expect(result).toBe("1.7.0")
        expect(pnpmCalls).toContain(`https://registry.npmjs.org/redrob-code/${InstallationChannel}`)
      }),
    )

    testEffect(testLayer(() => jsonResponse({ version: "2.3.4" }))).effect("reads scoop manifest versions", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("scoop")
        expect(result).toBe("2.3.4")
      }),
    )

    testEffect(testLayer(() => jsonResponse({ d: { results: [{ Version: "3.4.5" }] } }))).effect(
      "reads chocolatey feed versions",
      () =>
        Effect.gen(function* () {
          const result = yield* Installation.use.latest("choco")
          expect(result).toBe("3.4.5")
        }),
    )

    testEffect(
      testLayer(
        () => jsonResponse({ versions: { stable: "2.0.0" } }),
        (cmd, args) => {
          // getBrewFormula: return core formula (no tap)
          if (cmd === "brew" && args.includes("--formula") && args.includes("redrob-labs/tap/redrob")) return ""
          if (cmd === "brew" && args.includes("--formula") && args.includes("redrob")) return "redrob"
          return ""
        },
      ),
    ).effect("reads brew formulae API versions", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("brew")
        expect(result).toBe("2.0.0")
      }),
    )

    const brewInfoJson = JSON.stringify({
      formulae: [{ versions: { stable: "2.1.0" } }],
    })
    testEffect(
      testLayer(
        () => jsonResponse({}), // HTTP not used for tap formula
        (cmd, args) => {
          if (cmd === "brew" && args.includes("redrob-labs/tap/redrob") && args.includes("--formula")) return "redrob"
          if (cmd === "brew" && args.includes("--json=v2")) return brewInfoJson
          return ""
        },
      ),
    ).effect("reads brew tap info JSON via CLI", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("brew")
        expect(result).toBe("2.1.0")
      }),
    )
  })

  describe("upgrade", () => {
    const scriptCalls: string[] = []
    const scriptEnv: Array<Record<string, string | undefined>> = []
    testEffect(
      testLayer(
        (request) => {
          scriptCalls.push(request.url)
          return new Response("install script", { status: 200 })
        },
        (cmd, args, env) => {
          if (cmd === "bash" && args[0] === "--version") return "GNU bash"
          if (cmd === "bash") {
            scriptEnv.push(env)
            return "installed"
          }
          return ""
        },
      ),
    ).effect("runs the Console install script for the version it is upgrading to", () =>
      Effect.gen(function* () {
        yield* Installation.use.upgrade("curl", "9.9.9")
        expect(scriptCalls).toEqual([Installation.CONSOLE_INSTALL_SCRIPT_URL])
        expect(scriptCalls.some((url) => url.includes("code.redrob.ai/install"))).toBe(false)
        // The name the script reads. `VERSION` is the other installer's variable and this one
        // ignores it, which is an upgrade that silently reinstalls whatever `latest` is.
        expect(scriptEnv[0]?.["REDROB_CODE_VERSION"]).toBe("9.9.9")
        expect(scriptEnv[0]?.["VERSION"]).toBeUndefined()
        // The binary that is running gets replaced, rather than a second copy appearing in the
        // default directory when this install is somewhere else.
        expect(scriptEnv[0]?.["REDROB_CODE_INSTALL_DIR"]).toBe(path.dirname(process.execPath))
      }),
    )

    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd) => {
          if (cmd === "npm") return { code: 1, stderr: "token=secret command output" }
          return ""
        },
      ),
    ).effect("returns sanitized typed errors for failed package upgrades", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("npm", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe("Upgrade failed for npm (exit code 1).")
        expect(error.message).toBe(error.stderr)
        expect(error.stderr).not.toContain("secret")
        expect(error.stderr).not.toContain("command output")
      }),
    )

    testEffect(
      testLayer(
        () => new Response("install script with token=secret", { status: 200 }),
        (cmd, args) => {
          if (cmd === "bash" && args[0] === "--version") return "GNU bash"
          if (cmd === "bash" || cmd === "sh") return { code: 1, stderr: "script output with token=secret" }
          return ""
        },
      ),
    ).effect("returns sanitized typed errors when the curl install script fails", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("curl", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe("Upgrade failed for curl (exit code 1).")
        expect(error.message).toBe(error.stderr)
        expect(error.stderr).not.toContain("secret")
        expect(error.stderr).not.toContain("script output")
      }),
    )

    testEffect(
      testLayer(
        () => new Response("install script", { status: 200 }),
        (cmd, args) => {
          if (cmd === "bash" && args[0] === "--version") return { code: 1, stderr: "missing" }
          if (cmd === "bash") return { code: 1, stderr: "should not execute installer with bash" }
          if (cmd === "sh") return "ok"
          return ""
        },
      ),
    ).effect("falls back to sh when bash is unavailable during curl upgrade", () =>
      Effect.gen(function* () {
        yield* Installation.use.upgrade("curl", "9.9.9")
      }),
    )
  })

  describe("method", () => {
    test("places an install.sh binary as the curl method under either name", () => {
      const home = process.env["HOME"] ?? "/home/user"
      expect(Installation.isCurlInstall(path.join(home, ".redrob", "bin", "redrob"))).toBe(true)
      expect(Installation.isCurlInstall(path.join(home, ".redrob", "bin", "redrob-code"))).toBe(true)
      expect(Installation.isCurlInstall(path.join(home, ".redrob", "bin", "redrob.exe"))).toBe(true)
      expect(Installation.isCurlInstall(path.join(home, ".local", "bin", "redrob"))).toBe(true)
      expect(Installation.isCurlInstall(path.join(home, ".local", "bin", "redrob-code"))).toBe(true)
    })

    test("leaves binaries that are not ours, or not in those directories, to the package managers", () => {
      expect(Installation.isCurlInstall("/home/user/.local/bin/bun")).toBe(false)
      expect(Installation.isCurlInstall("/home/user/.redrob/bin/node")).toBe(false)
      expect(Installation.isCurlInstall("/opt/homebrew/bin/redrob")).toBe(false)
      expect(Installation.isCurlInstall("/usr/lib/node_modules/redrob-code/bin/redrob")).toBe(false)
    })
  })
})
