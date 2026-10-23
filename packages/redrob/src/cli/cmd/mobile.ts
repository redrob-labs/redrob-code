/**
 * `redrob mobile ...`: let the Redrob phone app drive this machine through the desk relay
 * (redrob-mobile `docs/desk-relay.md`).
 *
 * `login` signs this machine in as the redrob-auth `redrob-code` desktop client and stores only the
 * refresh token (`~/.redrob/channels/secrets.json`, 0600); the running daemon then starts the
 * relay. The pairing commands talk to the running daemon (`/desk/*`), which holds the relay
 * connection and the pending requests.
 */
import { cmd } from "./cmd"
import { UI } from "@/cli/ui"
import { Daemon } from "@/daemon/connect"
import { FileSecretStore } from "@redrob-code/channels-core"
import { endpoints, finishDeviceLogin, startDeviceLogin } from "@/desk/auth"
import { SCOPE } from "@/desk/pairing"

type Status = {
  running: boolean
  connected: boolean
  pending: { phoneId: string; name: string; code: string; expiresAt: number }[]
  phones: { id: string; name: string; addedAt: number; online: boolean }[]
}

async function daemon(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response | undefined> {
  const connection = await Daemon.current()
  if (!connection) return undefined
  return fetch(`${connection.url.replace(/\/+$/, "")}${path}`, {
    method: init.method ?? "GET",
    headers: { ...connection.headers, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined)
}

/** Tell the daemon to start or stop the relay after a sign-in change. */
async function reload(): Promise<boolean> {
  return (await daemon("/channels/reload", { method: "POST" }))?.ok === true
}

function fail(text: string): void {
  UI.println(`${UI.Style.TEXT_DANGER}${text}${UI.Style.TEXT_NORMAL}`)
  process.exitCode = 1
}

function noDaemon(): void {
  fail("no running engine; start it with: redrob service start")
}

async function errorText(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { message?: string } | null
  return body?.message ?? `HTTP ${response.status}`
}

async function status(): Promise<Status | undefined> {
  const response = await daemon("/desk/status")
  if (!response?.ok) {
    noDaemon()
    return undefined
  }
  const body = (await response.json()) as Status
  if (!body.running) {
    UI.println(`${UI.Style.TEXT_DIM}the desk relay is not running; sign in with: redrob mobile login${UI.Style.TEXT_NORMAL}`)
  }
  return body
}

async function post(path: string, body: unknown, done: (result: { id: string; name: string }) => string): Promise<void> {
  const response = await daemon(path, { method: "POST", body })
  if (!response) return noDaemon()
  if (!response.ok) return fail(await errorText(response))
  UI.println(done((await response.json()) as { id: string; name: string }))
}

export const MobileCommand = cmd({
  command: "mobile",
  describe: "control this machine from the Redrob phone app (sign in, pair phones)",
  builder: (yargs) =>
    yargs
      .command(
        cmd({
          command: "login",
          describe: "sign this machine in to your Redrob account so your phone can reach it",
          handler: async () => {
            const { issuer } = endpoints()
            const device = await startDeviceLogin(issuer)
            UI.println(`Open ${device.verificationUriComplete}`)
            UI.println(`and confirm the code ${UI.Style.TEXT_HIGHLIGHT_BOLD}${device.userCode}${UI.Style.TEXT_NORMAL}`)
            const tokens = await finishDeviceLogin(issuer, device)
            if (!tokens.refreshToken) throw new Error("redrob-auth returned no refresh token")
            await new FileSecretStore().set(SCOPE, "refreshToken", tokens.refreshToken)
            UI.println("signed in")
            if (await reload()) UI.println(`${UI.Style.TEXT_DIM}desk relay started${UI.Style.TEXT_NORMAL}`)
          },
        }),
      )
      .command(
        cmd({
          command: "logout",
          describe: "forget the sign-in and stop the desk relay (paired phones are kept)",
          handler: async () => {
            await new FileSecretStore().delete(SCOPE, "refreshToken")
            await reload()
            UI.println("signed out; the desk relay is off")
          },
        }),
      )
      .command(
        cmd({
          command: "pending",
          describe: "show phones waiting to pair with this machine, with their codes",
          builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
          handler: async (args) => {
            const body = await status()
            if (!body) return
            if (args.json) {
              process.stdout.write(JSON.stringify(body.pending) + "\n")
              return
            }
            if (body.running && body.pending.length === 0) {
              UI.println(`${UI.Style.TEXT_DIM}no pending pairing requests${UI.Style.TEXT_NORMAL}`)
            }
            for (const request of body.pending) {
              const left = Math.max(0, Math.round((request.expiresAt - Date.now()) / 1000))
              UI.println(`"${request.name}"  code ${request.code}  (${left}s left)  -> redrob mobile approve ${request.code}`)
            }
          },
        }),
      )
      .command(
        cmd({
          command: "approve <code>",
          describe: "allow the phone showing this 6-digit code to control this machine",
          builder: (yargs) => yargs.positional("code", { type: "string", demandOption: true }),
          handler: (args) =>
            post("/desk/pairings/reply", { code: String(args.code), decision: "approve" }, (phone) => `paired with "${phone.name}" (${phone.id})`),
        }),
      )
      .command(
        cmd({
          command: "deny <code>",
          describe: "refuse the phone showing this 6-digit code",
          builder: (yargs) => yargs.positional("code", { type: "string", demandOption: true }),
          handler: (args) =>
            post("/desk/pairings/reply", { code: String(args.code), decision: "deny" }, (phone) => `denied "${phone.name}"`),
        }),
      )
      .command(
        cmd({
          command: "list",
          describe: "show the phones paired with this machine",
          builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
          handler: async (args) => {
            const body = await status()
            if (!body) return
            if (args.json) {
              process.stdout.write(JSON.stringify(body.phones) + "\n")
              return
            }
            if (body.running) UI.println(`${UI.Style.TEXT_DIM}relay ${body.connected ? "connected" : "connecting"}${UI.Style.TEXT_NORMAL}`)
            if (body.phones.length === 0) UI.println(`${UI.Style.TEXT_DIM}no paired phones${UI.Style.TEXT_NORMAL}`)
            for (const phone of body.phones) {
              const added = new Date(phone.addedAt).toISOString().slice(0, 10)
              UI.println(`${phone.id}  "${phone.name}"  added ${added}${phone.online ? "  online" : ""}`)
            }
          },
        }),
      )
      .command(
        cmd({
          command: "revoke <id>",
          describe: "unpair a phone (ids from: redrob mobile list)",
          builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
          handler: (args) => post("/desk/phones/revoke", { id: String(args.id) }, (phone) => `revoked "${phone.name}"`),
        }),
      )
      .demandCommand(),
  handler: () => {},
})
