import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ServerAuth } from "@/server/auth"
import { createRedrobClient } from "@redrob-labs/sdk/v2"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { ACPProfile } from "@/acp/profile"

export const AcpCommand = effectCmd({
  command: "acp",
  describe: "start ACP (Agent Client Protocol) server",
  builder: (yargs) => {
    return withNetworkOptions(yargs)
      .option("cwd", {
        describe: "working directory",
        type: "string",
        default: process.cwd(),
      })
      .option("attach", {
        describe:
          "use the user's shared engine (start it if needed) instead of running one inside this process; one daemon serves every app",
        type: "boolean",
        default: false,
      })
  },
  handler: Effect.fn("Cli.acp")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("@/server/server"))
    const { ACP } = yield* Effect.promise(() => import("@/acp/agent"))
    ACPProfile.mark("cli.acp.handler")
    process.env.REDROB_CLIENT = "acp"
    // --attach: this process is only the ACP face; the engine is the shared daemon. Without it the
    // engine runs in here, as it always has.
    const sdk = args.attach
      ? yield* Effect.promise(async () => {
          const { Daemon } = await import("@/daemon/connect")
          const connection = await Daemon.connectOrStart()
          return createRedrobClient({ baseUrl: connection.url, headers: connection.headers })
        })
      : yield* Effect.gen(function* () {
          const opts = yield* resolveNetworkOptions(args)
          const server = yield* Effect.promise(() =>
            ACPProfile.measure("cli.acp.server.listen", () => Server.listen(opts)),
          )
          return createRedrobClient({
            baseUrl: `http://${server.hostname}:${server.port}`,
            headers: ServerAuth.headers(),
          })
        })

    const input = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          process.stdout.write(chunk, (err) => {
            if (err) {
              reject(err)
            } else {
              resolve()
            }
          })
        })
      },
    })
    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        process.stdin.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk))
        })
        process.stdin.on("end", () => controller.close())
        process.stdin.on("error", (err) => controller.error(err))
      },
    })

    const stream = ndJsonStream(input, output)
    const agent = ACP.init({ sdk })

    new AgentSideConnection((conn) => {
      ACPProfile.mark("cli.acp.connection.create")
      return agent.create(conn)
    }, stream)

    yield* Effect.logInfo("setup connection")
    process.stdin.resume()
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          process.stdin.on("end", () => resolve())
          process.stdin.on("error", reject)
        }),
    )
  }),
})
