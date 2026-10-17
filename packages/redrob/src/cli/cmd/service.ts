/**
 * `redrob service start | status | stop | restart | install | uninstall`: the user's shared daemon, by hand.
 *
 * Apps do the same through the SDK's `connectOrStart`; this is the command line and what the
 * launcher calls. `start --json` prints the record so a caller written in another language (the
 * launcher is Rust) gets the url and secret without parsing prose. `install` / `uninstall`
 * register or remove login start (see daemon/autostart.ts); `channels enable|disable` do that
 * automatically.
 */
import { cmd } from "./cmd"
import { UI } from "@/cli/ui"
import { Daemon } from "@/daemon/connect"
import * as Registry from "@/daemon/registry"
import * as Autostart from "@/daemon/autostart"
import { DEFAULT_IDLE_EXIT_MINUTES } from "./serve"

const print = (record: Registry.Record, json: boolean) => {
  if (json) {
    process.stdout.write(JSON.stringify(record) + "\n")
    return
  }
  UI.println(`${UI.Style.TEXT_SUCCESS_BOLD}running${UI.Style.TEXT_NORMAL} ${record.url} (pid ${record.pid}, v${record.version})`)
}

export const ServiceCommand = cmd({
  command: "service",
  describe: "manage the shared background engine other Redrob apps attach to",
  builder: (yargs) =>
    yargs
      .command(
        cmd({
          command: "start",
          describe: "find the shared engine, or start it",
          builder: (yargs) =>
            yargs
              .option("json", { type: "boolean", default: false, describe: "print the record as one JSON line" })
              .option("idle-exit", {
                type: "number",
                default: DEFAULT_IDLE_EXIT_MINUTES,
                describe: "when starting: minutes with no attached app before it exits (0 = stay up)",
              }),
          handler: async (args) => {
            const connection = await Daemon.connectOrStart({ idleExitMinutes: args["idle-exit"] })
            print(connection.record, args.json)
          },
        }),
      )
      .command(
        cmd({
          command: "status",
          describe: "show whether the shared engine is running",
          builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
          handler: async (args) => {
            const connection = await Daemon.current()
            if (args.json) {
              process.stdout.write(JSON.stringify(connection?.record ?? null) + "\n")
              if (!connection) process.exitCode = 1
              return
            }
            const autostart = await Autostart.status()
            if (!connection) {
              UI.println(`${UI.Style.TEXT_DIM}not running${UI.Style.TEXT_NORMAL}`)
              process.exitCode = 1
            } else {
              print(connection.record, false)
            }
            UI.println(
              autostart.installed
                ? `${UI.Style.TEXT_DIM}starts at login (${autostart.location})${UI.Style.TEXT_NORMAL}`
                : `${UI.Style.TEXT_DIM}not registered to start at login${UI.Style.TEXT_NORMAL}`,
            )
          },
        }),
      )
      .command(
        cmd({
          command: "stop",
          describe: "stop the shared engine",
          handler: async () => {
            const stopped = await Daemon.stop()
            UI.println(stopped ? "stopped" : `${UI.Style.TEXT_DIM}not running${UI.Style.TEXT_NORMAL}`)
          },
        }),
      )
      .command(
        cmd({
          command: "install",
          describe: "start the shared engine at login (systemd user / launchd / Task Scheduler)",
          builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
          handler: async (args) => {
            const state = await Autostart.install()
            if (args.json) process.stdout.write(JSON.stringify(state) + "\n")
            else UI.println(`${UI.Style.TEXT_SUCCESS_BOLD}installed${UI.Style.TEXT_NORMAL} ${state.location}`)
          },
        }),
      )
      .command(
        cmd({
          command: "uninstall",
          describe: "stop starting the shared engine at login",
          builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
          handler: async (args) => {
            const state = await Autostart.uninstall()
            if (args.json) process.stdout.write(JSON.stringify(state) + "\n")
            else UI.println(state.platform === "unsupported" ? `${UI.Style.TEXT_DIM}not supported on ${process.platform}${UI.Style.TEXT_NORMAL}` : "uninstalled")
          },
        }),
      )
      .command(
        cmd({
          command: "restart",
          describe: "stop the shared engine and start it again",
          builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
          handler: async (args) => {
            await Daemon.stop()
            const connection = await Daemon.connectOrStart()
            print(connection.record, args.json)
          },
        }),
      )
      .demandCommand(),
  handler: () => {},
})
