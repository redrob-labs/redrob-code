/**
 * `redrob drive setup | status | off`: turn this machine into a Redrob Drive.
 *
 * Redrob Drive is the non-developer packaging of Redrob Code whose only job is to let Redrob Chat
 * work with the files under the home folder. It has no window of its own -- a tray icon and the web
 * chat are the whole product. This command is the backend of its one-tap "Allow" screen, and it
 * plays the role the Redrob Launcher plays for Redrob Desktop:
 *
 *   1. register the engine to start at login, and start it now (always on);
 *   2. allow the whole home folder (`~/`), by writing the desk's `folders.json`;
 *   3. turn the desk on, so the relay carries requests from the web;
 *   4. sign in to the Redrob account, so the chat for that account can reach this machine.
 *
 * Approval stays at the daemon's defaults -- machine access `trusted`, Auto all on -- so the chat
 * works with the files without asking per file. That is the point of Drive; a person who wants the
 * asking back uses `redrob desk` / the launcher switch, same as Redrob Desktop.
 */
import { cmd } from "./cmd"
import { UI } from "@/cli/ui"
import { Daemon } from "@/daemon/connect"
import * as Autostart from "@/daemon/autostart"
import { setAllowedFolders, allowedFolders } from "@/desk/files"
import { homedir } from "node:os"
import open from "open"

type Login = { userCode: string; verificationUriComplete: string; expiresAt: number }

type Status = {
  enabled: boolean
  signedIn: boolean
  account?: { email: string }
  connected: boolean
  autoAll?: boolean
}

function fail(text: string): void {
  UI.println(`${UI.Style.TEXT_DANGER}${text}${UI.Style.TEXT_NORMAL}`)
  process.exitCode = 1
}

function dim(text: string): void {
  UI.println(`${UI.Style.TEXT_DIM}${text}${UI.Style.TEXT_NORMAL}`)
}

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

async function call<T>(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<T | undefined> {
  const response = await daemon(path, method, body)
  if (!response) {
    fail("no running engine; start it with: redrob service start")
    return undefined
  }
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { message?: string } | null
    fail(problem?.message ?? `HTTP ${response.status}`)
    return undefined
  }
  return (await response.json()) as T
}

/** Register the engine to start at login and have it running now, so Drive is always on. */
async function ensureEngine(): Promise<boolean> {
  const state = await Autostart.install().catch((error: unknown) => {
    dim(`could not register the engine to start at login: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  })
  if (state?.installed) {
    UI.println(`engine starts at login (${state.location})`)
    for (let i = 0; i < 75; i++) {
      if (await Daemon.current()) return true
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  const started = await Daemon.connectOrStart({ idleExitMinutes: 0 }).catch((error: unknown) => {
    fail(`could not start the engine: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  })
  return started !== undefined
}

function printStatus(status: Status, home: string[]): void {
  if (!status.signedIn) dim("not signed in; run: redrob drive setup")
  else UI.println(`signed in${status.account ? ` as ${status.account.email}` : ""}`)
  UI.println(`drive ${status.enabled ? "on" : "off"}, relay ${status.connected ? "connected" : "not connected"}`)
  if (status.autoAll !== undefined) UI.println(`works without asking: ${status.autoAll ? "on" : "off"}`)
  UI.println(home.length > 0 ? `allowed folders: ${home.join(", ")}` : "no folders allowed yet")
}

const SetupCommand = cmd({
  command: "setup",
  describe: "turn this computer into a Redrob Drive: always on, home folder open, signed in",
  handler: async () => {
    if (!(await ensureEngine())) return

    const home = homedir()
    await setAllowedFolders([home])
    UI.println(`opened your home folder to Redrob Chat: ${home}`)

    const enabled = await call<Status>("/desk/enable", "POST", { enabled: true })
    if (!enabled) return

    const status = await call<Status>("/desk/status")
    if (!status) return
    if (status.signedIn) {
      UI.println(`already signed in${status.account ? ` as ${status.account.email}` : ""}; Redrob Drive is on`)
      return
    }

    const login = await call<Login>("/desk/login", "POST")
    if (!login) return
    UI.println("")
    UI.println("Opening your browser to finish setup in Redrob Chat.")
    UI.println(`  if it does not open, go to ${login.verificationUriComplete}`)
    UI.println(`  and confirm the code ${UI.Style.TEXT_SUCCESS_BOLD}${login.userCode}${UI.Style.TEXT_NORMAL}`)
    await open(login.verificationUriComplete).catch(() => undefined)
  },
})

const StatusCommand = cmd({
  command: "status",
  describe: "show whether Redrob Drive is on, signed in and which folders are open",
  handler: async () => {
    const status = await call<Status>("/desk/status")
    if (!status) return
    printStatus(status, await allowedFolders())
  },
})

const OffCommand = cmd({
  command: "off",
  describe: "stop Redrob Drive: turn the desk off and unregister login start",
  handler: async () => {
    await call<Status>("/desk/enable", "POST", { enabled: false })
    const state = await Autostart.uninstall().catch(() => undefined)
    UI.println(state && !state.installed ? "Redrob Drive is off; it no longer starts at login" : "Redrob Drive is off")
  },
})

export const DriveCommand = cmd({
  command: "drive",
  describe: "manage Redrob Drive: let Redrob Chat work with this computer's files",
  builder: (yargs) =>
    yargs.command(SetupCommand).command(StatusCommand).command(OffCommand).demandCommand(1),
  handler: () => {},
})
