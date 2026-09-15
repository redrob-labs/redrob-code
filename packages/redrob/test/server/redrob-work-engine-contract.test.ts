import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { OpenApi } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { InstallationVersion } from "@redrob-code/core/installation/version"
import { SERVER_LISTENING_PREFIX, serverListeningLine } from "../../src/cli/cmd/serve"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { InstancePaths } from "../../src/server/routes/instance/httpapi/groups/instance"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The Redrob Work dependency contract, asserted from this side.
//
// Redrob Work is the only GUI and the only consumer that matters. It spawns this binary as a
// packaged sidecar (REDROB_CODE_BIN or the packaged sidecar, `apps/desktop/electron/runtime.mjs`),
// waits for the startup line on stdout, polls `/global/health`, reads `/doc` for the API surface,
// and addresses one project per request with `x-redrob-directory`. None of that was pinned as a
// contract here, so a rename or a reworded line broke the GUI in the other repo instead of failing
// a test in this one.
//
// Everything below runs in process against the production route tree. `redrob serve`'s own spawn
// path already has subprocess coverage in test/cli/serve/serve-process.test.ts; the startup line
// itself is asserted here against the exported contract rather than by spawning a second process,
// because the string is what the GUI matches on and a spawn proves nothing extra about it.
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    // resetDatabase() disposes instances too, so per-directory instance state cannot leak between
    // this file's routing assertions and any other server test in the same bun process.
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()))
  }),
)

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)

const httpApiServerLayer = servedRoutes.pipe(
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

const it = testEffect(Layer.mergeAll(testStateLayer, httpApiServerLayer))

const DIRECTORY_HEADER = "x-redrob-directory"
// Upstream OpenCode's header. Redrob Code reads only its own, and Redrob Work sets only its own, so
// this must stay unrecognised rather than quietly becoming a second way to address a project.
const UPSTREAM_DIRECTORY_HEADER = "x-opencode-directory"

const inDirectory = (path: string, directory: string) =>
  HttpClientRequest.get(path).pipe(HttpClientRequest.setHeader(DIRECTORY_HEADER, directory), HttpClient.execute)

describe("Redrob Work engine contract", () => {
  describe("startup readiness line", () => {
    it.effect("prints the prefix Redrob Work waits for, with the bound URL", () =>
      Effect.gen(function* () {
        const line = serverListeningLine({ hostname: "127.0.0.1", port: 4096 })
        expect(line).toBe("redrob server listening on http://127.0.0.1:4096")
        // The GUI and both SDK server helpers test the prefix, then extract the URL from the tail.
        expect(line.startsWith(SERVER_LISTENING_PREFIX)).toBe(true)
        expect(line.match(/on\s+(https?:\/\/[^\s]+)/)?.[1]).toBe("http://127.0.0.1:4096")
        // One line, and nothing after the URL: a consumer reading line-by-line must not have to
        // strip trailing punctuation or a second sentence.
        expect(line).not.toContain("\n")
        expect(line.endsWith("4096")).toBe(true)
      }),
    )

    it.effect("keeps the host and port the server actually bound", () =>
      Effect.gen(function* () {
        // Port 0 means "OS assigns", so the line has to carry the resolved port; a consumer that
        // parsed the requested port would connect to the wrong place.
        expect(serverListeningLine({ hostname: "0.0.0.0", port: 51234 })).toBe(
          "redrob server listening on http://0.0.0.0:51234",
        )
      }),
    )
  })

  describe("/global/health", () => {
    it.effect("is served at the documented path and reports healthy with a version", () =>
      Effect.gen(function* () {
        expect(GlobalPaths.health).toBe("/global/health")
        const response = yield* HttpClient.get(GlobalPaths.health)
        expect(response.status).toBe(200)
        // Redrob Work polls this to decide the engine is up. `healthy` is the literal true, and
        // `version` is what the GUI surfaces as the engine version.
        expect(yield* response.json).toEqual({ healthy: true, version: InstallationVersion })
      }),
    )

    it.effect("needs no directory header, because it is not instance-scoped", () =>
      Effect.gen(function* () {
        // The GUI probes health before it knows which project to open, so this must answer without
        // routing to an instance.
        const response = yield* HttpClient.get(GlobalPaths.health)
        expect(response.status).toBe(200)
      }),
    )
  })

  describe("/doc", () => {
    it.effect("serves the OpenAPI document at /doc", () =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get("/doc")
        expect(response.status).toBe(200)
        expect(response.headers["content-type"]).toContain("application/json")
        const spec = (yield* response.json) as { openapi?: string; paths?: Record<string, unknown> }
        expect(typeof spec.openapi).toBe("string")
        // The routes the GUI depends on have to be in the published surface, not just reachable.
        expect(Object.keys(spec.paths ?? {})).toContain(GlobalPaths.health)
        expect(Object.keys(spec.paths ?? {})).toContain(InstancePaths.path)
      }),
    )

    it.effect("publishes the same document Server.openapi() builds from PublicApi", () =>
      Effect.gen(function* () {
        // Pins the path, not just the payload: /doc is a raw route outside the declared API, so
        // nothing else would catch it moving to /openapi.json or /docs.
        const served = yield* HttpClient.get("/doc").pipe(Effect.flatMap((response) => response.json))
        expect(served).toEqual(JSON.parse(JSON.stringify(OpenApi.fromApi(PublicApi))))
      }),
    )

    it.effect("404s an unmatched path instead of falling through to a catch-all", () =>
      Effect.gen(function* () {
        // The embedded web UI and its catch-all are gone. A GUI probing an unknown path must get a
        // 404, not HTML from a proxy.
        const response = yield* HttpClient.get("/not-a-route")
        expect(response.status).toBe(404)
      }),
    )
  })

  describe("per-directory routing", () => {
    it.effect("routes each request to the instance named by x-redrob-directory", () =>
      Effect.gen(function* () {
        const first = yield* tmpdirScoped({ git: true })
        const second = yield* tmpdirScoped({ git: true })

        const firstPath = yield* inDirectory(InstancePaths.path, first).pipe(
          Effect.flatMap((response) => response.json),
        )
        const secondPath = yield* inDirectory(InstancePaths.path, second).pipe(
          Effect.flatMap((response) => response.json),
        )

        // Two headers, two instances: this is how one running engine serves every workspace the GUI
        // has open, so the resolved directory must follow the header and nothing else.
        expect(firstPath).toMatchObject({ directory: first, worktree: first })
        expect(secondPath).toMatchObject({ directory: second, worktree: second })
      }),
    )

    it.effect("ignores x-opencode-directory", () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped({ git: true })
        const response = yield* HttpClientRequest.get(InstancePaths.path).pipe(
          HttpClientRequest.setHeader(UPSTREAM_DIRECTORY_HEADER, directory),
          HttpClient.execute,
        )
        expect(response.status).toBe(200)
        // The request is still served, from the server's own cwd — the upstream header does not
        // select a project. Asserting the resolved directory rather than the status is the point: a
        // status-only check would pass even if the header were honoured.
        const body = (yield* response.json) as { directory: string }
        expect(body.directory).not.toBe(directory)
        expect(body.directory).toBe(process.cwd())
      }),
    )

    it.effect("prefers x-redrob-directory when both headers are present", () =>
      Effect.gen(function* () {
        const redrob = yield* tmpdirScoped({ git: true })
        const upstream = yield* tmpdirScoped({ git: true })
        const response = yield* HttpClientRequest.get(InstancePaths.path).pipe(
          HttpClientRequest.setHeader(DIRECTORY_HEADER, redrob),
          HttpClientRequest.setHeader(UPSTREAM_DIRECTORY_HEADER, upstream),
          HttpClient.execute,
        )
        expect(response.status).toBe(200)
        expect(yield* response.json).toMatchObject({ directory: redrob })
      }),
    )
  })
})
