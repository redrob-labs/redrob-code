import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@redrob-code/core/flag/flag"

// The startup handshake Redrob Work depends on.
//
// Redrob Work spawns this binary as a packaged sidecar and blocks until it reads a line beginning
// with this prefix on stdout; `packages/sdk/js/src/server.ts` and its v2 twin do the same, then pull
// the base URL out of the ` on <url>` tail. Nothing acknowledges a change to either half, so a
// reworded line would hang the GUI at startup with no error to read. Exported as one contract so
// that shape is pinned by a test instead of living inline in a template literal.
export const SERVER_LISTENING_PREFIX = "redrob server listening"

export const serverListeningLine = (server: { hostname: string; port: number }) =>
  `${SERVER_LISTENING_PREFIX} on http://${server.hostname}:${server.port}`

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless redrob server",
  // Server loads instances per-request via x-redrob-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.REDROB_SERVER_PASSWORD) {
      console.log("Warning: REDROB_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(serverListeningLine(server))

    yield* Effect.never
  }),
})
