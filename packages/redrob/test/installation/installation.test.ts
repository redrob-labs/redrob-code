import { describe, expect, test } from "bun:test"
import { makeGlobalNode } from "@redrob-code/core/effect/app-node"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { httpClient } from "@redrob-code/core/effect/app-node-platform"
import { Effect, Exit, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { CrossSpawnSpawner } from "@redrob-code/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
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
    deps: () => [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttpClient(httpHandler)],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

describe("installation", () => {
  describe("latest", () => {
    const calls: string[] = []
    testEffect(
      testLayer((request) => {
        calls.push(request.url)
        return textResponse("1.2.3\n")
      }),
    ).effect("reads the version marker published beside the newest release", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest()
        expect(result).toBe("1.2.3")
        // One source, and it is a redirect rather than the API. `api.github.com` allows an
        // anonymous caller 60 requests an hour, and every person running these builds is one.
        expect(calls).toEqual([
          `${Installation.RELEASE_DOWNLOAD_BASE}/latest/download/${Installation.RELEASE_VERSION_FILE}`,
        ])
        expect(calls.some((url) => url.includes("api.github.com"))).toBe(false)
        // The bucket is gone. Its marker sat at 0.0.12 for ten days while a different version
        // line shipped ten releases, because a person had to run the publish script by hand.
        expect(calls.some((url) => url.includes("cdn.redrob.ai"))).toBe(false)
      }),
    )

    testEffect(testLayer(() => textResponse("v4.0.0\n"))).effect("strips a v prefix from the marker", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest()
        expect(result).toBe("4.0.0")
      }),
    )

    testEffect(testLayer(() => new Response("<html>404</html>", { status: 200 }))).effect(
      "refuses a marker that does not name a version",
      () =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(Installation.use.latest())
          expect(Exit.isFailure(exit)).toBe(true)
        }),
    )

    test("asks the release for the marker, honoring an override", () => {
      expect(Installation.RELEASE_VERSION_FILE).toBe("VERSION")
      expect(Installation.releaseVersionUrl({})).toBe(
        `${Installation.RELEASE_DOWNLOAD_BASE}/latest/download/VERSION`,
      )
      // `latest/download/<name>` resolves to whichever release is newest, so no client has to
      // know a tag and a page never has to be edited on release day.
      expect(Installation.RELEASE_DOWNLOAD_BASE).toBe("https://github.com/redrob-labs/redrob-code/releases")
      // The override install.sh was pointed at is the one asked for here.
      expect(Installation.releaseVersionUrl({ REDROB_CODE_DOWNLOAD_BASE: "http://127.0.0.1:8080/releases/" })).toBe(
        "http://127.0.0.1:8080/releases/latest/download/VERSION",
      )
    })
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

    testEffect(testLayer(() => jsonResponse({}))).effect("refuses to upgrade an install it did not place", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("unknown", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        // Re-running install.sh over a binary somebody else put here would write into whatever
        // directory it happens to sit in, so this says what to run instead of guessing.
        expect(error.stderr).toContain("was not installed by install.sh")
        expect(error.stderr).toContain(Installation.CONSOLE_INSTALL_SCRIPT_URL)
        expect(error.message).toBe(error.stderr)
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
