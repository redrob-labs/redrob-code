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
import { NpmConfig } from "@redrob-code/core/npm-config"
import { InstallationEvent } from "@redrob-code/schema/installation-event"

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

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
 * The installer Console serves, and the bucket it downloads from.
 *
 * `curl -fsSL https://console.redrob.ai/code/install.sh | sh` is the public install path, so it is
 * also the upgrade path: the script is fetched and re-run with the version to move to. It reads
 * `REDROB_CODE_VERSION`, `REDROB_CODE_INSTALL_DIR` and `REDROB_CODE_DOWNLOAD_BASE`, and it fetches
 * `$REDROB_CODE_DOWNLOAD_BASE/$VERSION/redrob-code-$OS-$ARCH.tar.gz`, which is what
 * `packages/redrob/script/cdn.ts` publishes. Nothing on this path reads GitHub Releases: this
 * repository is private, so `api.github.com` answers 404 for the people running these builds.
 */
export const CONSOLE_INSTALL_SCRIPT_URL = "https://console.redrob.ai/code/install.sh"
export const CDN_DOWNLOAD_BASE = "https://cdn.redrob.ai/code"

/**
 * The marker `script/cdn.ts` writes last under each prefix it publishes, holding the version those
 * archives are. It is written after the archives so a version it names is always downloadable.
 */
export const CDN_VERSION_FILE = "version"

// Response schemas for external version APIs
const NpmPackage = Schema.Struct({ version: Schema.String })
const BrewFormula = Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })
const BrewInfoV2 = Schema.Struct({
  formulae: Schema.Array(Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })),
})
const ChocoPackage = Schema.Struct({
  d: Schema.Struct({ results: Schema.Array(Schema.Struct({ Version: Schema.String })) }),
})
const ScoopManifest = NpmPackage

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
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

/** Where `latest()` asks what the newest published build is, honoring a self-hosted bucket. */
export function cdnVersionUrl(env: Record<string, string | undefined> = process.env) {
  const base = env["REDROB_CODE_DOWNLOAD_BASE"]?.trim().replace(/\/+$/, "") || CDN_DOWNLOAD_BASE
  return `${base}/latest/${CDN_VERSION_FILE}`
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

    const run = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.catch((err) => Effect.succeed({ code: 1, stdout: "", stderr: errorMessage(err) })),
    )

    const getBrewFormula = Effect.fnUntraced(function* () {
      const tapFormula = yield* text(["brew", "list", "--formula", "redrob-labs/tap/redrob"])
      if (tapFormula.includes("redrob")) return "redrob-labs/tap/redrob"
      const coreFormula = yield* text(["brew", "list", "--formula", "redrob"])
      if (coreFormula.includes("redrob")) return "redrob"
      return "redrob"
    })

    const upgradeFailure = (method: Method, result?: { code: number; stdout: string; stderr: string }) => {
      if (method === "choco") return "not running from an elevated command shell"
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
        if (isCurlInstall(process.execPath)) return "curl" as Method
        const exec = process.execPath.toLowerCase()

        const checks: Array<{ name: Method; command: () => Effect.Effect<string> }> = [
          { name: "npm", command: () => text(["npm", "list", "-g", "--depth=0"]) },
          { name: "yarn", command: () => text(["yarn", "global", "list"]) },
          { name: "pnpm", command: () => text(["pnpm", "list", "-g", "--depth=0"]) },
          { name: "bun", command: () => text(["bun", "pm", "ls", "-g"]) },
          { name: "brew", command: () => text(["brew", "list", "--formula", "redrob"]) },
          { name: "scoop", command: () => text(["scoop", "list", "redrob"]) },
          { name: "choco", command: () => text(["choco", "list", "--limit-output", "redrob"]) },
        ]

        checks.sort((a, b) => {
          const aMatches = exec.includes(a.name)
          const bMatches = exec.includes(b.name)
          if (aMatches && !bMatches) return -1
          if (!aMatches && bMatches) return 1
          return 0
        })

        for (const check of checks) {
          const output = yield* check.command()
          const installedName =
            check.name === "brew" || check.name === "choco" || check.name === "scoop" ? "redrob" : "redrob-code"
          if (output.includes(installedName)) {
            return check.name
          }
        }

        return "unknown" as Method
      }),
      latest: Effect.fn("Installation.latest")(function* (installMethod?: Method) {
        const detectedMethod = installMethod || (yield* result.method())

        if (detectedMethod === "brew") {
          const formula = yield* getBrewFormula()
          if (formula.includes("/")) {
            const infoJson = yield* text(["brew", "info", "--json=v2", formula])
            const info = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(BrewInfoV2))(infoJson)
            return info.formulae[0].versions.stable
          }
          const response = yield* httpOk.execute(
            HttpClientRequest.get("https://formulae.brew.sh/api/formula/redrob.json").pipe(
              HttpClientRequest.acceptJson,
            ),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(BrewFormula)(response)
          return data.versions.stable
        }

        if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
          const response = yield* httpOk.execute(
            HttpClientRequest.get(
              `${yield* NpmConfig.registry(process.cwd())}/redrob-code/${InstallationChannel}`,
            ).pipe(HttpClientRequest.acceptJson),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(NpmPackage)(response)
          return data.version
        }

        if (detectedMethod === "choco") {
          const response = yield* httpOk.execute(
            HttpClientRequest.get(
              "https://community.chocolatey.org/api/v2/Packages?$filter=Id%20eq%20%27redrob%27%20and%20IsLatestVersion&$select=Version",
            ).pipe(HttpClientRequest.setHeaders({ Accept: "application/json;odata=verbose" })),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(ChocoPackage)(response)
          return data.d.results[0].Version
        }

        if (detectedMethod === "scoop") {
          const response = yield* httpOk.execute(
            HttpClientRequest.get(
              "https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/redrob.json",
            ).pipe(HttpClientRequest.setHeaders({ Accept: "application/json" })),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(ScoopManifest)(response)
          return data.version
        }

        // Everything else, `curl` and an install we could not place alike, reads the CDN marker. It
        // is the version install.sh can actually fetch, which a GitHub release on a private repo is
        // not, and an unreadable marker is a defect rather than a version nobody can install.
        const url = cdnVersionUrl()
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
          case "npm":
            upgradeResult = yield* run(["npm", "install", "-g", `redrob-code@${target}`])
            break
          case "pnpm":
            upgradeResult = yield* run(["pnpm", "install", "-g", `redrob-code@${target}`])
            break
          case "bun":
            upgradeResult = yield* run(["bun", "install", "-g", `redrob-code@${target}`])
            break
          case "brew": {
            const formula = yield* getBrewFormula()
            const env = { HOMEBREW_NO_AUTO_UPDATE: "1" }
            if (formula.includes("/")) {
              const tap = yield* run(["brew", "tap", "redrob-labs/tap"], { env })
              if (tap.code !== 0) {
                upgradeResult = tap
                break
              }
              const repo = yield* text(["brew", "--repo", "redrob-labs/tap"])
              const dir = repo.trim()
              if (dir) {
                const pull = yield* run(["git", "pull", "--ff-only"], { cwd: dir, env })
                if (pull.code !== 0) {
                  upgradeResult = pull
                  break
                }
              }
            }
            upgradeResult = yield* run(["brew", "upgrade", formula], { env })
            break
          }
          case "choco":
            upgradeResult = yield* run(["choco", "upgrade", "redrob", `--version=${target}`, "-y"])
            break
          case "scoop":
            upgradeResult = yield* run(["scoop", "install", `redrob@${target}`])
            break
          default:
            return yield* new UpgradeFailedError({ stderr: `Unknown installation method: ${m}` })
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
