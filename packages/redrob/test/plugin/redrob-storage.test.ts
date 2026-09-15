import { describe, expect } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { Effect } from "effect"
import { FSUtil } from "@redrob-code/core/fs-util"
import { Global } from "@redrob-code/core/global"
import { ProviderV2 } from "@redrob-code/core/provider"
import { Config } from "@/config/config"
import { ProviderAuth } from "@/provider/auth"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { CrossSpawnSpawner } from "@redrob-code/core/cross-spawn-spawner"
import { TestConfig } from "../fixture/config"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * Where the key a device connect earns actually ends up.
 *
 * The unit suite next door proves the conversation with the console. This one proves the only thing
 * that matters afterwards: that the key crosses ProviderAuth and lands in the one auth.json this
 * CLI has always kept, under the same provider id and in the same record a pasted REDROB_API_KEY
 * produces. Nothing is stubbed but the console itself, which is a local HTTP server.
 */

const it = testEffect(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node])))

const REDROB = ProviderV2.ID.make("redrob")
const KEY = "test-rrk_a1b2c3d4_ZXhhbXBsZXNlY3JldA"
const DEVICE_CODE = "device-code-bearer-value"

function providerAuthLayer(directory: string, plugins: string[]) {
  return LayerNode.compile(ProviderAuth.node, [
    [
      Config.node,
      TestConfig.layer({
        get: () =>
          Effect.succeed({
            plugin: plugins,
            plugin_origins: plugins.map((plugin) => ({
              spec: plugin,
              source: path.join(directory, "redrob.json"),
              scope: "local" as const,
            })),
          }),
        directories: () => Effect.succeed([directory]),
      }),
    ],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ])
}

/** The console's device endpoints, on a real port, answering pending once and then handing a key. */
function serveConsole() {
  let polls = 0
  return Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/device/authorize")) {
        return Response.json({
          deviceCode: DEVICE_CODE,
          userCode: "K7QM-2XR9",
          // On the origin the request arrived on: the client opens a verification page only when it
          // is served by the console it is already talking to.
          verificationUri: `${url.origin}/connect`,
          verificationUriComplete: `${url.origin}/connect?code=K7QM-2XR9`,
          expiresIn: 600,
          interval: 5,
        })
      }
      polls += 1
      if (polls === 1) {
        return Response.json({ error: "authorization_pending", statusCode: 400 }, { status: 400 })
      }
      return Response.json({ apiKey: KEY, apiKeyId: "key_1", product: "code" })
    },
  })
}

/**
 * A user plugin that is the real built-in, only pointed at the local console and told not to open a
 * browser or wait. Overriding by provider id is how the plugin layer already lets a user replace a
 * built-in credential flow (see plugin/auth-override.test.ts), so this reaches ProviderAuth through
 * the same seam a real device connect does.
 */
function pluginSource(baseUrl: string) {
  const module = pathToFileURL(path.join(import.meta.dir, "..", "..", "src", "plugin", "redrob.ts")).href
  return [
    `import { RedrobAuthPlugin } from ${JSON.stringify(module)}`,
    `export default {`,
    `  id: "test.redrob-device-connect",`,
    `  server: (input) =>`,
    `    RedrobAuthPlugin(input, {`,
    `      baseUrl: ${JSON.stringify(baseUrl)},`,
    `      openBrowser: async () => undefined,`,
    `      sleep: async () => {},`,
    `    }),`,
    `}`,
    ``,
  ].join("\n")
}

describe("plugin.redrob storage", () => {
  it.instance("offers device connect and a pasted key for the console provider", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const methods = yield* ProviderAuth.use.methods().pipe(Effect.provide(providerAuthLayer(tmp.directory, [])))

      // Read by the TUI through GET /provider/auth to build the /connect dialog, and by
      // `redrob providers login` to build its method picker.
      expect(methods[REDROB]?.map((method) => ({ type: method.type, label: method.label }))).toEqual([
        { type: "oauth", label: "Connect Redrob" },
        { type: "api", label: "Paste an API key from console.redrob.ai" },
      ])
    }),
  )

  it.instance("a completed device connect writes the console's key to the one auth.json", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const fs = yield* FSUtil.Service
      const server = serveConsole()
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))

      const file = path.join(Global.Path.data, "auth.json")
      const plugin = path.join(tmp.directory, ".redrob", "plugin", "redrob-device-connect.ts")
      yield* fs.writeWithDirs(plugin, pluginSource(new URL("/api/backend/v1", server.url).toString()))
      const layer = providerAuthLayer(tmp.directory, [pathToFileURL(plugin).href])

      const before = ((yield* fs.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>)[
        "redrob"
      ]
      expect(before).toBeUndefined()

      const authorization = yield* Effect.gen(function* () {
        const started = yield* ProviderAuth.use.authorize({ providerID: REDROB, method: 0 })
        // One provide, because the pending authorization lives in the service that started it: a
        // second build of the layer would be a second, empty ProviderAuth.
        yield* ProviderAuth.use.callback({ providerID: REDROB, method: 0 })
        return started
      }).pipe(Effect.provide(layer))

      expect(authorization?.method).toBe("auto")
      expect(authorization?.instructions).toContain("K7QM-2XR9")
      // The pending connection's bearer stays server side; only the code a person types comes back.
      expect(JSON.stringify(authorization)).not.toContain(DEVICE_CODE)

      /**
       * Asserted against the file rather than the service, because the claim is about the location:
       * this is the path `redrob providers list` prints and the path a pasted key is written to.
       * The record is an ordinary `api` credential, which is exactly what PUT /auth/redrob stores
       * when someone pastes REDROB_API_KEY, so nothing downstream has to learn a second shape.
       */
      const stored = (yield* fs.readJson(file)) as Record<string, unknown>
      expect(stored["redrob"]).toEqual({ type: "api", key: KEY })
      expect(file).toBe(path.join(Global.Path.data, "auth.json"))
    }),
  )
})
