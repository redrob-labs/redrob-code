/**
 * `redrob apps list | unregister <id>`: the desktop apps whose MCP tool servers the shared daemon
 * is bridged to (docs/APP-BRIDGE.md). Talks to the daemon the record names; spawns nothing.
 */
import { cmd } from "./cmd"
import { UI } from "@/cli/ui"
import { Daemon } from "@/daemon/connect"

type BridgedApp = {
  id: string
  name: string
  mcpUrl: string
  pid: number
  version?: string
  tools?: string[]
  registeredAt: number
  lastSeen: number
}

type BridgedAppList = { apps: BridgedApp[]; ttlMs: number }

function age(sinceMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - sinceMs) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60}m`
  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length)
}

async function daemon(json: boolean): Promise<Daemon.Connection | undefined> {
  const connection = await Daemon.current()
  if (!connection) {
    if (json) process.stdout.write(JSON.stringify(null) + "\n")
    else UI.println(`${UI.Style.TEXT_DIM}engine not running${UI.Style.TEXT_NORMAL}`)
    process.exitCode = 1
  }
  return connection
}

export const AppsCommand = cmd({
  command: "apps",
  describe: "the desktop apps bridged to the shared engine (their MCP tool servers)",
  builder: (yargs) =>
    yargs
      .command(
        cmd({
          command: "list",
          describe: "list bridged apps",
          builder: (yargs) => yargs.option("json", { type: "boolean", default: false, describe: "print the list as JSON" }),
          handler: async (args) => {
            const connection = await daemon(args.json)
            if (!connection) return
            const response = await fetch(`${connection.url.replace(/\/+$/, "")}/v1/apps`, { headers: connection.headers })
            if (!response.ok) {
              UI.error(`the engine answered ${response.status} to GET /v1/apps`)
              process.exitCode = 1
              return
            }
            const list = (await response.json()) as BridgedAppList
            if (args.json) {
              process.stdout.write(JSON.stringify(list) + "\n")
              return
            }
            if (list.apps.length === 0) {
              UI.println(`${UI.Style.TEXT_DIM}no apps bridged${UI.Style.TEXT_NORMAL}`)
              return
            }
            const now = Date.now()
            const rows = list.apps.map((app) => [
              app.name,
              String(app.pid),
              app.mcpUrl,
              app.tools ? String(app.tools.length) : "-",
              age(app.registeredAt, now),
              app.id,
            ])
            const header = ["NAME", "PID", "MCP URL", "TOOLS", "AGE", "ID"]
            const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
            UI.println(UI.Style.TEXT_DIM + header.map((h, i) => pad(h, widths[i]!)).join("  ") + UI.Style.TEXT_NORMAL)
            for (const row of rows) UI.println(row.map((cell, i) => pad(cell, widths[i]!)).join("  "))
          },
        }),
      )
      .command(
        cmd({
          command: "unregister <id>",
          describe: "drop a bridged app: the engine disconnects its MCP server",
          builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true, describe: "the registration id from `redrob apps list`" }),
          handler: async (args) => {
            const connection = await daemon(false)
            if (!connection) return
            const response = await fetch(`${connection.url.replace(/\/+$/, "")}/v1/apps/${encodeURIComponent(args.id)}`, {
              method: "DELETE",
              headers: connection.headers,
            })
            if (!response.ok) {
              UI.error(`the engine answered ${response.status} to DELETE /v1/apps/${args.id}`)
              process.exitCode = 1
              return
            }
            UI.println("unregistered")
          },
        }),
      )
      .demandCommand(),
  handler: () => {},
})
