/**
 * `redrob desk ...` (alias `redrob mobile ...`): let Redrob Chat on the web and the Redrob phone app
 * drive this machine through the desk relay (redrob-mobile `docs/desk-relay.md`).
 *
 * Every subcommand calls the running daemon's local `/desk/*` routes, the same ones the launcher
 * uses. The daemon holds the sign-in, the relay connection, the pending requests and the approved
 * devices.
 */
import { cmd } from "./cmd"
import { UI } from "@/cli/ui"
import { Daemon } from "@/daemon/connect"

type Kind = "phone" | "web"

type Login = { userCode: string; verificationUriComplete: string; expiresAt: number }

type Status = {
  enabled: boolean
  signedIn: boolean
  account?: { email: string }
  connected: boolean
  login?: Login
  pending: { code: string; name: string; kind: Kind; expiresAt: number }[]
  devices: { id: string; name: string; kind: Kind; addedAt: number; online: boolean }[]
}

type Device = { id: string; name: string; kind: Kind }

async function daemon(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<Response | undefined> {
  const connection = await Daemon.current()
  if (!connection) return undefined
  return fetch(`${connection.url.replace(/\/+$/, "")}${path}`, {
    method,
    headers: { ...connection.headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined)
}

function fail(text: string): void {
  UI.println(`${UI.Style.TEXT_DANGER}${text}${UI.Style.TEXT_NORMAL}`)
  process.exitCode = 1
}

function dim(text: string): void {
  UI.println(`${UI.Style.TEXT_DIM}${text}${UI.Style.TEXT_NORMAL}`)
}

async function errorText(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { message?: string } | null
  return body?.message ?? `HTTP ${response.status}`
}

/** One call; prints the failure and returns undefined when it did not succeed. */
async function call<T>(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<T | undefined> {
  const response = await daemon(path, method, body)
  if (!response) {
    fail("no running engine; start it with: redrob service start")
    return undefined
  }
  if (!response.ok) {
    fail(await errorText(response))
    return undefined
  }
  return (await response.json()) as T
}

function kindLabel(kind: Kind): string {
  return kind === "web" ? "web" : "phone"
}

function printStatus(status: Status): void {
  if (!status.signedIn) dim("not signed in; run: redrob desk login")
  else UI.println(`signed in${status.account ? ` as ${status.account.email}` : ""}`)
  UI.println(`desk ${status.enabled ? "on" : "off"}, relay ${status.connected ? "connected" : "not connected"}`)
  if (status.pending.length > 0) UI.println(`${status.pending.length} device(s) waiting; run: redrob desk pending`)
  UI.println(`${status.devices.length} approved device(s)`)
}

export const DeskCommand = cmd({
  command: "desk",
  aliases: ["mobile"],
  describe: "use this machine from Redrob Chat on the web and the Redrob phone app",
  builder: (yargs) =>
    yargs
      .command(
        cmd({
          command: "status",
          describe: "show the sign-in, the relay connection and devices",
          builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
          handler: async (args) => {
            const status = await call<Status>("/desk/status")
            if (!status) return
            if (args.json) return void process.stdout.write(JSON.stringify(status) + "\n")
            printStatus(status)
          },
        }),
      )
      .command(
        cmd({
          command: "enable",
          describe: "turn the desk relay on (it runs while this machine is signed in)",
          handler: async () => {
            const status = await call<Status>("/desk/enable", "POST", { enabled: true })
            if (status) printStatus(status)
          },
        }),
      )
      .command(
        cmd({
          command: "disable",
          describe: "turn the desk relay off; nothing can reach this machine until it is on again",
          handler: async () => {
            const status = await call<Status>("/desk/enable", "POST", { enabled: false })
            if (status) printStatus(status)
          },
        }),
      )
      .command(
        cmd({
          command: "login",
          describe: "sign this machine in to your Redrob account so your devices can reach it",
          handler: async () => {
            const login = await call<Login>("/desk/login", "POST")
            if (!login) return
            UI.println(`Open ${login.verificationUriComplete}`)
            UI.println(`and confirm the code ${UI.Style.TEXT_HIGHLIGHT_BOLD}${login.userCode}${UI.Style.TEXT_NORMAL}`)
            // The daemon polls the token endpoint; wait here until it reports the result.
            while (Date.now() < login.expiresAt) {
              await new Promise((resolve) => setTimeout(resolve, 2_000))
              const response = await daemon("/desk/status")
              if (!response?.ok) continue
              const status = (await response.json()) as Status
              if (status.signedIn) {
                UI.println(`signed in${status.account ? ` as ${status.account.email}` : ""}`)
                if (!status.enabled) dim("the desk is off; turn it on with: redrob desk enable")
                return
              }
              if (!status.login) return fail("sign-in did not finish; run: redrob desk login")
            }
            fail("the sign-in code expired; run: redrob desk login")
          },
        }),
      )
      .command(
        cmd({
          command: "logout",
          describe: "forget the sign-in and stop the desk relay (approved devices are kept)",
          handler: async () => {
            const status = await call<Status>("/desk/logout", "POST")
            if (status) UI.println("signed out; the desk relay is off")
          },
        }),
      )
      .command(
        cmd({
          command: "pending",
          describe: "show devices waiting for your approval, with their codes",
          builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
          handler: async (args) => {
            const status = await call<Status>("/desk/status")
            if (!status) return
            if (args.json) return void process.stdout.write(JSON.stringify(status.pending) + "\n")
            if (status.pending.length === 0) dim("no devices waiting")
            for (const request of status.pending) {
              const left = Math.max(0, Math.round((request.expiresAt - Date.now()) / 1000))
              UI.println(
                `"${request.name}" (${kindLabel(request.kind)})  code ${request.code}  (${left}s left)  -> redrob desk approve ${request.code}`,
              )
            }
          },
        }),
      )
      .command(
        cmd({
          command: "approve <code>",
          describe: "allow the device showing this 6-digit code to use this machine",
          builder: (yargs) => yargs.positional("code", { type: "string", demandOption: true }),
          handler: async (args) => {
            const device = await call<Device>(`/desk/pending/${encodeURIComponent(String(args.code))}/approve`, "POST")
            if (device) UI.println(`approved "${device.name}" (${kindLabel(device.kind)}, ${device.id})`)
          },
        }),
      )
      .command(
        cmd({
          command: "deny <code>",
          describe: "refuse the device showing this 6-digit code",
          builder: (yargs) => yargs.positional("code", { type: "string", demandOption: true }),
          handler: async (args) => {
            const device = await call<Device>(`/desk/pending/${encodeURIComponent(String(args.code))}/deny`, "POST")
            if (device) UI.println(`denied "${device.name}"`)
          },
        }),
      )
      .command(
        cmd({
          command: "list",
          describe: "show the devices approved for this machine",
          builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
          handler: async (args) => {
            const status = await call<Status>("/desk/status")
            if (!status) return
            if (args.json) return void process.stdout.write(JSON.stringify(status.devices) + "\n")
            dim(`relay ${status.connected ? "connected" : "not connected"}`)
            if (status.devices.length === 0) dim("no approved devices")
            for (const device of status.devices) {
              const added = new Date(device.addedAt).toISOString().slice(0, 10)
              UI.println(
                `${device.id}  "${device.name}" (${kindLabel(device.kind)})  added ${added}${device.online ? "  online" : ""}`,
              )
            }
          },
        }),
      )
      .command(
        cmd({
          command: "revoke <id>",
          describe: "remove an approved device (ids from: redrob desk list)",
          builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
          handler: async (args) => {
            const device = await call<Device>(`/desk/devices/${encodeURIComponent(String(args.id))}/revoke`, "POST")
            if (device) UI.println(`removed "${device.name}"`)
          },
        }),
      )
      .demandCommand(),
  handler: () => {},
})
