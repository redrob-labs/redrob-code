import os from "node:os"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@redrob-code/core/flag/flag"
import { InstallationVersion } from "@redrob-code/core/installation/version"

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

/** Default minutes with nobody attached before a registered daemon exits. */
export const DEFAULT_IDLE_EXIT_MINUTES = 10

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .option("register", {
        type: "boolean",
        default: false,
        describe:
          "run as the user's shared daemon: draw a secret, write ~/.redrob/run/server.json for other Redrob apps to find, exit when idle",
      })
      .option("idle-exit", {
        type: "number",
        default: DEFAULT_IDLE_EXIT_MINUTES,
        describe: "with --register: minutes with no attached app before exiting (0 = stay up)",
      }),
  describe: "starts a headless redrob server",
  // Server loads instances per-request via x-redrob-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const register = args.register === true
    // The shared daemon outlives whoever started it. A caller that spawned it from an app's
    // install folder (older SDKs did) would otherwise have that folder held open for the daemon's
    // whole life, blocking the app's Windows update. Requests carry their own directory.
    if (register) {
      try {
        process.chdir(os.homedir())
      } catch {
        /* keep the inherited cwd */
      }
    }
    const Registry = register ? yield* Effect.promise(() => import("../../daemon/registry")) : undefined
    // The daemon's secret is per start. It must be in the environment BEFORE the server's config
    // layer reads it, and it is what goes into the record, so other apps can authenticate.
    const secret = Registry ? Registry.newSecret() : undefined
    if (secret) process.env.REDROB_SERVER_PASSWORD = secret
    else if (!Flag.REDROB_SERVER_PASSWORD) {
      console.log("Warning: REDROB_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(serverListeningLine(server))

    if (Registry && secret) {
      const { setIdleExitAfterMs } = yield* Effect.promise(() => import("@redrob-code/server/handlers/clients"))
      const Clients = yield* Effect.promise(() => import("@redrob-code/server/clients"))
      const Apps = yield* Effect.promise(() => import("@redrob-code/server/apps"))
      const id = Registry.newID()
      yield* Effect.promise(() =>
        Registry.write({
          id,
          version: InstallationVersion,
          url: `http://${server.hostname}:${server.port}`,
          port: server.port,
          pid: process.pid,
          secret,
        }),
      )
      const idleExitMs = args["idle-exit"] > 0 ? args["idle-exit"] * 60_000 : undefined
      setIdleExitAfterMs(idleExitMs)

      // Chat channels (Slack, Telegram, ...) run inside the daemon. While any is on, the daemon
      // must stay up for the bot to answer, so idle exit is off for as long as one is running;
      // it is restored when a reload turns the last one off.
      const Channels = yield* Effect.promise(() => import("@redrob-code/channels-core"))
      const ServerChannels = yield* Effect.promise(() => import("@redrob-code/server/channels"))
      const { channelFactories } = yield* Effect.promise(() => import("../../channels/registry"))
      const daemon = { url: `http://${server.hostname}:${server.port}`, headers: Registry.headers(secret) }
      const channels = Channels.manager({ daemon })
      // The desk (web and phone -> this daemon, docs/desk-relay.md in redrob-mobile): the
      // `/desk/*` local routes, and the relay connection, which runs while the `desk` switch is on
      // (the default) and the machine is signed in. Like a channel, the relay keeps the daemon up
      // while it runs, so a device can reach it.
      const Desk = yield* Effect.promise(() => import("../../desk/service"))
      const desk = new Desk.DeskService(daemon, undefined, () => applyIdlePolicy())
      const applyIdlePolicy = () => setIdleExitAfterMs(channels.active || desk.active ? undefined : idleExitMs)
      // Map the service's own errors onto the route errors.
      const found = async <A>(run: () => Promise<A> | A): Promise<A> => {
        try {
          return await run()
        } catch (error) {
          if (error instanceof Desk.NotFound) throw new ServerChannels.DeskNotFound(error.message)
          throw error
        }
      }
      ServerChannels.setController({
        status: () => channels.status(),
        reload: async () => {
          const running = await channels.reload()
          await desk.reconcile()
          applyIdlePolicy()
          return running
        },
        desk: {
          status: () => desk.status(),
          enable: (enabled) => desk.enable(enabled),
          login: async () => {
            try {
              return await desk.startLogin()
            } catch (error) {
              if (error instanceof Desk.AlreadySignedIn) throw new ServerChannels.DeskConflict(error.message)
              throw error
            }
          },
          logout: () => desk.logout(),
          approve: (code) => found(() => desk.approve(code)),
          deny: (code) => found(() => desk.deny(code)),
          revoke: (id) => found(() => desk.revoke(id)),
        },
      })
      const started = yield* Effect.promise(() => channels.startEnabledChannels(channelFactories).catch(() => []))
      yield* Effect.promise(() => desk.reconcile())
      applyIdlePolicy()
      if (started.length > 0) console.log(`channels: ${started.join(", ")}`)
      if (desk.active) console.log("desk relay: on")

      let leaving = false
      const leave = (code: number) => {
        if (leaving) return
        leaving = true
        desk.stop()
        void channels
          .stopAll()
          .catch(() => undefined)
          .then(() => Registry.remove(id))
          .catch(() => undefined)
          .then(() => server.stop(true))
          .finally(() => process.exit(code))
      }
      process.once("SIGTERM", () => leave(0))
      process.once("SIGINT", () => leave(0))

      // Watch the record: a newer daemon that took the file over means this one should go. Watch
      // the clients: once nobody has been attached for the idle window, go too.
      const tick = setInterval(() => {
        void Registry.read().then((current) => {
          if (current && current.id !== id) return leave(0)
          // Bridged apps first: dropping one detaches its client, which the client sweep then sees.
          Apps.sweep()
          Clients.sweep()
          const idle = Clients.idleFor()
          if (channels.active || desk.active) return
          if (idleExitMs !== undefined && idle !== undefined && idle >= idleExitMs) leave(0)
        })
      }, 10_000)
      tick.unref()
    }

    yield* Effect.never
  }),
})
