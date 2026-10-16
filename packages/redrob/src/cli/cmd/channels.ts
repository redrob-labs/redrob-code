/**
 * `redrob channels ...`: configure the chat channels the shared daemon serves.
 *
 * Edits `~/.redrob/channels.json` (non-secret) and `~/.redrob/channels/secrets.json` (0600), then
 * asks a running registered daemon to re-read the file with `POST /channels/reload`. Nothing here
 * starts a daemon: enabling a channel with no daemon running takes effect on its next start.
 */
import { cmd } from "./cmd"
import { UI } from "@/cli/ui"
import { Daemon } from "@/daemon/connect"
import { Config, FileSecretStore, type ChannelName } from "@redrob-code/channels-core"

const NAMES = Config.CHANNEL_NAMES

function channelName(value: string): ChannelName {
  if (Config.isChannelName(value)) return value
  throw new Error(`Unknown channel "${value}"; one of: ${NAMES.join(", ")}`)
}

type Status = { name: string; enabled: boolean; connected: boolean; available: boolean; lastError?: string }

/** The running daemon's view, or undefined when none is registered. */
async function daemonStatus(): Promise<Status[] | undefined> {
  const connection = await Daemon.current()
  if (!connection) return undefined
  const response = await fetch(`${connection.url.replace(/\/+$/, "")}/channels/status`, {
    headers: connection.headers,
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined)
  if (!response?.ok) return undefined
  const body = (await response.json().catch(() => null)) as { channels?: Status[] } | null
  return body?.channels
}

/** Tell a running daemon to re-read channels.json. Quietly does nothing when none is running. */
async function reload(): Promise<boolean> {
  const connection = await Daemon.current()
  if (!connection) return false
  const response = await fetch(`${connection.url.replace(/\/+$/, "")}/channels/reload`, {
    method: "POST",
    headers: connection.headers,
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined)
  return response?.ok === true
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

const after = (reloaded: boolean) =>
  UI.println(
    reloaded
      ? `${UI.Style.TEXT_DIM}daemon reloaded${UI.Style.TEXT_NORMAL}`
      : `${UI.Style.TEXT_DIM}no running daemon; takes effect on its next start${UI.Style.TEXT_NORMAL}`,
  )

export const SLACK_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "im:history",
  "im:read",
  "im:write",
  "channels:history",
  "groups:history",
  "mpim:history",
  "users:read",
] as const

export const SLACK_EVENTS = ["app_mention", "message.im", "message.channels"] as const

export function slackManifest(): string {
  return [
    "display_information:",
    "  name: Redrob",
    "  description: Talk to your Redrob Code engine from Slack.",
    "  background_color: '#1a1a1a'",
    "features:",
    "  bot_user:",
    "    display_name: Redrob",
    "    always_online: true",
    "oauth_config:",
    "  scopes:",
    "    bot:",
    ...SLACK_SCOPES.map((scope) => `      - ${scope}`),
    "settings:",
    "  event_subscriptions:",
    "    bot_events:",
    ...SLACK_EVENTS.map((event) => `      - ${event}`),
    "  interactivity:",
    "    is_enabled: false",
    "  org_deploy_enabled: false",
    "  socket_mode_enabled: true",
    "  token_rotation_enabled: false",
    "",
  ].join("\n")
}

export function slackManifestUrl(): string {
  return `https://api.slack.com/apps?new_app=1&manifest_yaml=${encodeURIComponent(slackManifest())}`
}

export const ChannelsCommand = cmd({
  command: "channels",
  describe: "chat channels (Slack, Telegram, Discord, WhatsApp) served by the shared engine",
  builder: (yargs) =>
    yargs
      .command(
        cmd({
          command: "list",
          describe: "show the configured channels",
          builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
          handler: async (args) => {
            const config = await Config.load()
            const secrets = new FileSecretStore()
            const rows = []
            for (const name of NAMES) {
              const entry = config.channels[name] ?? Config.defaultChannel()
              rows.push({ name, enabled: entry.enabled, allowlist: [...entry.allowlist], secrets: await secrets.keys(name) })
            }
            if (args.json) {
              process.stdout.write(JSON.stringify({ directory: config.directory, channels: rows }) + "\n")
              return
            }
            for (const row of rows) {
              const state = row.enabled
                ? `${UI.Style.TEXT_SUCCESS_BOLD}enabled${UI.Style.TEXT_NORMAL}`
                : `${UI.Style.TEXT_DIM}disabled${UI.Style.TEXT_NORMAL}`
              UI.println(
                `${row.name.padEnd(9)} ${state}  allow: ${row.allowlist.length ? row.allowlist.join(", ") : "(nobody)"}  secrets: ${row.secrets.length ? row.secrets.join(", ") : "(none)"}`,
              )
            }
          },
        }),
      )
      .command(
        cmd({
          command: "status",
          describe: "show which channels the running engine has connected",
          builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
          handler: async (args) => {
            const live = await daemonStatus()
            if (!live) {
              if (args.json) process.stdout.write(JSON.stringify(null) + "\n")
              else UI.println(`${UI.Style.TEXT_DIM}no running engine${UI.Style.TEXT_NORMAL}`)
              process.exitCode = 1
              return
            }
            if (args.json) {
              process.stdout.write(JSON.stringify(live) + "\n")
              return
            }
            for (const row of live) {
              const state = !row.enabled
                ? `${UI.Style.TEXT_DIM}disabled${UI.Style.TEXT_NORMAL}`
                : row.connected
                  ? `${UI.Style.TEXT_SUCCESS_BOLD}connected${UI.Style.TEXT_NORMAL}`
                  : !row.available
                    ? `${UI.Style.TEXT_WARNING}no transport in this build${UI.Style.TEXT_NORMAL}`
                    : `${UI.Style.TEXT_DANGER}not connected${UI.Style.TEXT_NORMAL}`
              UI.println(`${row.name.padEnd(9)} ${state}${row.lastError ? `  ${UI.Style.TEXT_DIM}${row.lastError}${UI.Style.TEXT_NORMAL}` : ""}`)
            }
          },
        }),
      )
      .command(
        cmd({
          command: "enable <name>",
          describe: "turn a channel on",
          builder: (yargs) => yargs.positional("name", { type: "string", demandOption: true, choices: NAMES }),
          handler: async (args) => {
            const name = channelName(args.name)
            const config = await Config.update((c) => Config.setChannel(c, name, { enabled: true }))
            if ((config.channels[name]?.allowlist.length ?? 0) === 0) {
              UI.println(`${UI.Style.TEXT_WARNING}allowlist is empty: nobody can talk to it yet (redrob channels allow ${name} <senderId>)${UI.Style.TEXT_NORMAL}`)
            }
            after(await reload())
          },
        }),
      )
      .command(
        cmd({
          command: "disable <name>",
          describe: "turn a channel off",
          builder: (yargs) => yargs.positional("name", { type: "string", demandOption: true, choices: NAMES }),
          handler: async (args) => {
            const name = channelName(args.name)
            await Config.update((c) => Config.setChannel(c, name, { enabled: false }))
            after(await reload())
          },
        }),
      )
      .command(
        cmd({
          command: "allow <name> <senderId>",
          describe: "let a platform user id talk to the engine through a channel",
          builder: (yargs) =>
            yargs
              .positional("name", { type: "string", demandOption: true, choices: NAMES })
              .positional("senderId", { type: "string", demandOption: true })
              .option("remove", { type: "boolean", default: false, describe: "remove the id instead" }),
          handler: async (args) => {
            const name = channelName(args.name)
            const id = args.senderId.trim()
            if (!id) throw new Error("senderId is empty")
            await Config.update((c) => {
              const current = c.channels[name] ?? Config.defaultChannel()
              const allowlist = args.remove
                ? current.allowlist.filter((x) => x !== id)
                : [...new Set([...current.allowlist, id])]
              return Config.setChannel(c, name, { allowlist })
            })
            after(await reload())
          },
        }),
      )
      .command(
        cmd({
          command: "set-secret <name> <key>",
          describe: "store a channel secret (bot token, app token, ...) in the 0600 secrets file",
          builder: (yargs) =>
            yargs
              .positional("name", { type: "string", demandOption: true, choices: NAMES })
              .positional("key", { type: "string", demandOption: true })
              .option("value", { type: "string", describe: "the secret; read from stdin when omitted" }),
          handler: async (args) => {
            const name = channelName(args.name)
            const value = (args.value ?? (await readStdin())).replace(/\r?\n$/, "")
            if (!value) throw new Error("empty secret; pass --value or pipe it on stdin")
            await new FileSecretStore().set(name, args.key, value)
            UI.println(`stored ${name}.${args.key}`)
            after(await reload())
          },
        }),
      )
      .command(
        cmd({
          command: "slack-manifest",
          describe: "print the Slack app manifest (YAML) for the Redrob bot",
          builder: (yargs) =>
            yargs.option("url", {
              type: "boolean",
              default: false,
              describe: "print the api.slack.com link that creates the app from this manifest",
            }),
          handler: (args) => {
            process.stdout.write(args.url ? slackManifestUrl() + "\n" : slackManifest())
          },
        }),
      )
      .demandCommand(),
  handler: () => {},
})
