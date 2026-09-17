import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { AppNodeBuilder } from "@redrob-code/core/effect/app-node-builder"
import { httpClient } from "@redrob-code/core/effect/app-node-platform"
import { Effect, Layer, Schema, Context, Stream } from "effect"
import { serviceUse } from "@redrob-code/core/effect/service-use"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { errorMessage } from "@/util/error"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@redrob-code/core/process"
import path from "path"
import { makeRuntime } from "@redrob-code/core/effect/runtime"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "@redrob-code/core/installation/version"
import { InstallationEvent } from "@redrob-code/schema/installation-event"

/**
 * How this binary got here.
 *
 * `curl` is an install.sh / install.ps1 install, which is the only way we publish. There
 * used to be `npm`, `yarn`, `pnpm`, `bun`, `brew`, `scoop` and `choco` here, and not one of
 * them was ever published: the npm package does not exist, the Homebrew formula does not
 * exist, and the Chocolatey feed returns an empty result set that the old lookup indexed
 * into unguarded. Detecting a channel we do not publish to means answering "your version is
 * out of date" with a 404, or crashing, so they are gone.
 *
 * `unknown` is a binary we cannot place: a build from source, or a copy someone moved. It is
 * not upgradable in place and the CLI says so rather than guessing.
 */
export type Method = "curl" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = InstallationEvent

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  return `redrob/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

/**
 * The installer Console serves, and the releases it downloads from.
 *
 * `curl -fsSL https://console.redrob.ai/code/install.sh | sh` is the public install path, so it is
 * also the upgrade path: the script is fetched and re-run with the version to move to. It reads
 * `REDROB_CODE_VERSION`, `REDROB_CODE_INSTALL_DIR` and `REDROB_CODE_DOWNLOAD_BASE`, and it fetches
 * `$REDROB_CODE_DOWNLOAD_BASE/download/v$VERSION/redrob-$OS-$ARCH.<ext>`.
 *
 * There is no CDN. Builds are published as GitHub Release assets on this repository, which is
 * public, and that is the only place they exist. The bucket that used to hold them was written by
 * a script somebody ran by hand, so it went stale the moment nobody remembered to: its version
 * marker sat at `0.0.12` while the tenth release of a different version line was already out.
 */
export const CONSOLE_INSTALL_SCRIPT_URL = "https://console.redrob.ai/code/install.sh"

/** Where the releases live. `REDROB_CODE_DOWNLOAD_BASE` overrides it so a test can point at loopback. */
export const RELEASE_DOWNLOAD_BASE = "https://github.com/redrob-labs/redrob-code/releases"

/**
 * The asset naming the newest version, published by the release workflow after the checksums.
 *
 * `releases/latest/download/<name>` resolves to whichever release is newest, so nothing has to
 * know a tag, and nothing here consults `api.github.com`, which is rate limited to 60 requests an
 * hour for an anonymous caller. Everyone running these builds is an anonymous caller.
 */
export const RELEASE_VERSION_FILE = "VERSION"

// No response schemas for external version APIs: the only thing consulted is our own release
// marker, which is a bare version string rather than a document.

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: () => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

/**
 * Whether this binary was put here by `install.sh`.
 *
 * The script writes `$REDROB_CODE_INSTALL_DIR/<name>`, defaulting to `$HOME/.redrob/bin`, and the
 * name it writes has been both `redrob` and `redrob-code`, so the directory identifies the install
 * and the file in it only has to be one of ours: a `bun` or `node` that happens to live in
 * `~/.local/bin` is not a Redrob Code install and must not be upgraded by re-running the installer.
 */
export function isCurlInstall(execPath: string) {
  const name = path.basename(execPath, path.extname(execPath))
  if (name !== "redrob" && name !== "redrob-code") return false
  const dir = path.dirname(execPath)
  return dir.endsWith(path.join(".redrob", "bin")) || dir.endsWith(path.join(".local", "bin"))
}

/** Where `latest()` asks what the newest published build is, honoring an override for tests. */
export function releaseVersionUrl(env: Record<string, string | undefined> = process.env) {
  const base = env["REDROB_CODE_DOWNLOAD_BASE"]?.trim().replace(/\/+$/, "") || RELEASE_DOWNLOAD_BASE
  return `${base}/latest/download/${RELEASE_VERSION_FILE}`
}

export class Service extends Context.Service<Service, Interface>()("@redrob/Installation") {}

export const use = serviceUse(Service)

const layer: Layer.Layer<Service, never, HttpClient.HttpClient | AppProcess.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
    const appProcess = yield* AppProcess.Service

    const text = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return result.stdout.toString("utf8")
      },
      Effect.catch(() => Effect.succeed("")),
    )

    const upgradeFailure = (method: Method, result?: { code: number; stdout: string; stderr: string }) => {
      if (result) return `Upgrade failed for ${method} (exit code ${result.code}).`
      return `Upgrade failed for ${method}.`
    }

    const upgradeScriptShell = Effect.fnUntraced(function* () {
      const bashVersion = yield* text(["bash", "--version"])
      if (bashVersion) return "bash"
      return "sh"
    })

    const upgradeCurl = Effect.fnUntraced(
      function* (target: string) {
        const response = yield* httpOk.execute(HttpClientRequest.get(CONSOLE_INSTALL_SCRIPT_URL))
        const body = yield* response.text
        const bodyBytes = new TextEncoder().encode(body)
        const shell = yield* upgradeScriptShell()
        const result = yield* appProcess.run(
          ChildProcess.make(shell, [], {
            stdin: Stream.make(bodyBytes),
            // The directory rather than the default, so the binary that is running is the one
            // replaced when it was installed somewhere other than `$HOME/.redrob/bin`. Anything else
            // the user set, `REDROB_CODE_DOWNLOAD_BASE` included, arrives through the inherited env.
            env: { REDROB_CODE_VERSION: target, REDROB_CODE_INSTALL_DIR: path.dirname(process.execPath) },
            extendEnv: true,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.mapError(() => new UpgradeFailedError({ stderr: upgradeFailure("curl") })),
    )

    const result: Interface = {
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest(),
        }
      }),
      method: Effect.fn("Installation.method")(function* () {
        // One question now: did install.sh / install.ps1 put this binary here. There used to be
        // seven package-manager probes below this line, each shelling out to a tool that might not
        // exist to look for a package we never published. They ran on every `redrob upgrade`.
        if (isCurlInstall(process.execPath)) return "curl" as Method
        return "unknown" as Method
      }),
      latest: Effect.fn("Installation.latest")(function* () {
        // One source. `releases/latest/download/VERSION` is written by the release workflow after
        // the checksums, so a version it names is always downloadable, and it resolves through
        // GitHub's own redirect rather than the API, which has no anonymous rate budget worth
        // spending here.
        //
        // An unreadable or unparseable marker is a defect and dies loudly. The alternative is
        // reporting some fallback as "latest", which is how a client sits on a version for ten
        // days believing it is current.
        const url = releaseVersionUrl()
        const response = yield* httpOk.execute(HttpClientRequest.get(url))
        const published = (yield* response.text).trim().replace(/^v/, "")
        if (!semver.valid(published))
          return yield* Effect.die(new Error(`${url} does not name a version: ${published.slice(0, 80)}`))
        return published
      }, Effect.orDie),
      upgrade: Effect.fn("Installation.upgrade")(function* (m: Method, target: string) {
        let upgradeResult: { code: number; stdout: string; stderr: string } | undefined
        switch (m) {
          case "curl":
            upgradeResult = yield* upgradeCurl(target)
            break
          default:
            // `unknown`. Re-running install.sh over a binary we did not place would write into
            // whatever directory it happens to sit in, so this refuses and the CLI tells the
            // reader to install with the published command instead.
            return yield* new UpgradeFailedError({
              stderr: `redrob at ${process.execPath} was not installed by install.sh, so it cannot be upgraded in place. Reinstall with: curl -fsSL ${CONSOLE_INSTALL_SCRIPT_URL} | sh`,
            })
        }
        if (!upgradeResult || upgradeResult.code !== 0) {
          return yield* new UpgradeFailedError({ stderr: upgradeFailure(m, upgradeResult) })
        }
        yield* Effect.logInfo("upgraded", {
          method: m,
          target,
          stdout: upgradeResult.stdout,
          stderr: upgradeResult.stderr,
        })
        yield* text([process.execPath, "--version"])
      }),
    }

    return Service.of(result)
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: () => [httpClient, AppProcess.node] })

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."
