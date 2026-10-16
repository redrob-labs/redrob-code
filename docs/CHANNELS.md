# Chat channels

Talk to the shared Redrob Code engine from Slack, Telegram, Discord or WhatsApp. The bots run
*inside* the daemon (`redrob serve --register`, see `LOCAL-ENGINE-API.md` section 3), so there is
one process to keep up, one set of credentials, and the sessions a chat creates are ordinary
engine sessions every other Redrob app can see.

Stage 1 (this document) is the core: configuration, secrets, the allowlist, the conversation to
session mapping, the renderer, the daemon wiring, the HTTP endpoints and the CLI. Stage 2 adds the
transports themselves, one per platform, against the `Transport` contract at the end.

## Files

| File | Mode | Holds |
| --- | --- | --- |
| `~/.redrob/channels.json` | 0644 | which channels are on, who may talk, non-secret settings |
| `~/.redrob/channels/secrets.json` | 0600 | bot tokens and other secrets, per channel |
| `~/.redrob/channels/sessions.json` | 0600 | conversation -> engine session map |

`REDROB_CHANNELS_HOME` moves all three (default `~/.redrob`), the way `REDROB_RUN_DIR` moves the
daemon record.

### `channels.json`

```json
{
  "version": 1,
  "directory": "/path/the/sessions/work/in",
  "channels": {
    "slack": {
      "enabled": true,
      "allowlist": ["U0123ABCDEF"],
      "directory": "/an/override/for/this/channel",
      "maxChunk": 3900,
      "options": {}
    },
    "telegram": { "enabled": false, "allowlist": [] }
  }
}
```

- `directory` is the project directory new sessions are created in (the engine's
  `x-redrob-directory`). The file-level value is the default; a channel may override it. When
  neither is set, the user's home.
- `allowlist` is the list of platform sender ids allowed to talk. **Empty means nobody.** A denied
  sender gets one "You are not allowed to use this bot." reply per daemon start and a warning in
  the daemon log; nothing reaches the engine.
- `maxChunk` caps a reply chunk for this channel (default: the transport's own limit, else 3900).
- `options` is free-form, non-secret, read by the transport (Stage 2 documents its keys).

Unknown channel names and malformed entries are dropped on load. The CLI edits this file; editing
it by hand and running `redrob channels enable <name>` (or `POST /channels/reload`) is fine too.

### `secrets.json`

```json
{ "slack": { "botToken": "xoxb-…", "appToken": "xapp-…" } }
```

Written by `redrob channels set-secret`, created `0600` in a `0700` folder, never read by the CLI
except to list key *names*. Transports see it through the `SecretStore` interface
(`get`, `set`, `delete`, `keys`), and only their own channel's slice, so the file store can be
swapped for a keychain later without touching a transport.

Secret keys per channel:

| Channel | Key | Holds |
| --- | --- | --- |
| `slack` | `botToken` | bot user OAuth token (`xoxb-…`) |
| `slack` | `appToken` | app-level token for Socket Mode (`xapp-…`) |
| `telegram` | `botToken` | the token @BotFather hands out (`packages/channels/telegram/README.md`) |

### `sessions.json`

One conversation is one engine session. The key is `<channel>:<conversationId>` -- a Slack
channel + thread, a Telegram chat id, a Discord channel id, a WhatsApp JID. The binding records
the `sessionID`, the `directory` it was created in and timestamps. A daemon restart continues the
same sessions; `/new` in the chat drops the binding so the next message starts a fresh one. If
the engine no longer knows the session (404), the dispatcher rebinds and resends once.

## In the chat

| Message | Does |
| --- | --- |
| `/new` | start a fresh session for this conversation |
| `/status` | show the session this conversation is bound to |
| `/help` | list these |
| anything else | sent as a prompt to the session; the assistant's text comes back |

Messages within one conversation are handled strictly in order; different conversations run in
parallel. Replies are rendered from markdown to plain-ish text (headings and emphasis flattened,
links as `text (url)`, code fences kept) and split into chunks the platform accepts, never cutting
inside a code fence when a line or paragraph break is available.

## Daemon

`redrob serve --register` loads `channels.json` after it has written the daemon record. Every
enabled channel that has a transport in `packages/redrob/src/channels/registry.ts` is started,
attached to the daemon as a client named `channel:<name>` (so `GET /api/clients` lists it), and
**idle exit is turned off for as long as any channel runs** -- a bot that is on must be reachable.
When a reload turns the last channel off, the `--idle-exit` policy is restored. `SIGTERM`/`SIGINT`
stop the transports before the record is removed.

A channel enabled in the file but with no transport in the build (Stage 1: all of them) is
reported in `status` as `available: false` with `lastError: "no transport is available for this
channel in this build"`; it does not keep the daemon up.

## HTTP

Both are under the daemon's Basic auth (`redrob:<secret>` from `server.json`) and take no
location header. `GET /channels/status` is a status poll and does not count as daemon activity.

```
GET  /channels/status  -> { "channels": [ { "name", "enabled", "connected", "available", "lastError"? } ] }
POST /channels/reload  -> { "running": ["slack"] }
```

`reload` re-reads `channels.json`: newly enabled channels start, disabled ones stop, a channel
whose entry changed is restarted. An embedded server (no `--register`) answers with empty lists.

## CLI

```
redrob channels list                                # configured channels, allowlists, secret key names
redrob channels status [--json]                     # what the running daemon has connected (exit 1 when none)
redrob channels enable <name>
redrob channels disable <name>
redrob channels allow <name> <senderId> [--remove]
redrob channels set-secret <name> <key> [--value v]  # value from stdin when --value is omitted
redrob channels slack-manifest [--url]
```

`<name>` is one of `slack`, `telegram`, `discord`, `whatsapp`. `enable`, `disable`, `allow` and
`set-secret` write the file and then `POST /channels/reload` on the running registered daemon;
with no daemon the change waits for the next start.

`slack-manifest` prints the Slack app manifest: bot named **Redrob**, Socket Mode on, bot scopes
`app_mentions:read chat:write im:history im:read im:write channels:history groups:history
mpim:history users:read`, bot events `app_mention message.im message.channels`. With `--url` it
prints `https://api.slack.com/apps?new_app=1&manifest_yaml=<urlencoded>`, which opens the "create
app" page pre-filled.

Setting up Slack, once the transport exists:

```sh
redrob channels slack-manifest --url          # open it, create the app, install to the workspace
redrob channels set-secret slack botToken     # paste xoxb-… , Ctrl-D
redrob channels set-secret slack appToken     # paste xapp-… (Socket Mode, connections:write), Ctrl-D
redrob channels allow slack U0123ABCDEF       # your Slack member id
redrob channels enable slack
```

## Transport contract (for Stage 2)

Package `@redrob-code/channels-core`, file `src/transport.ts`.

```ts
export type Inbound = {
  channel: string           // "slack"
  conversationId: string    // stable id of the conversation == one session
  senderId: string          // what the allowlist matches
  senderName?: string
  text: string
  replyTo?: string          // platform message id to answer in-thread, if any
}

export type TransportContext = {
  config: ChannelConfig              // this channel's entry from channels.json
  secrets: ChannelSecrets            // get(key) / require(key) / keys(), this channel only
  daemon: { url: string; headers: { Authorization: string } }
  log: Logger                        // info / warn / error
  onMessage: (message: Inbound) => void
}

export interface Transport {
  readonly name: string
  readonly maxChunk?: number         // platform limit; renderer splits to fit (default 3900)
  start(ctx: TransportContext): Promise<void>   // resolve when connected, reject on failure
  stop(): Promise<void>
  send(conversationId: string, chunks: readonly string[], replyTo?: string): Promise<void>
  typing?(conversationId: string): Promise<void>
}
```

Rules a transport follows:

1. Call `ctx.onMessage` for every human message and never answer on its own. The core decides
   whether the sender is allowed, which session it is, and what to reply; the transport only sees
   `send`. Drop the bot's own messages and platform noise (joins, edits) before calling.
2. `conversationId` must be stable for the lifetime of the conversation and unique within the
   channel. Threads are conversations: Slack uses `<channel>:<thread_ts>`.
3. `send` delivers chunks in order and resolves when the platform accepted them. One chunk is
   already under `maxChunk`; do not re-split.
4. Read secrets through `ctx.secrets.require("botToken")` at `start`, never from the
   environment -- the daemon's env belongs to nobody (see `LOCAL-ENGINE-API.md`).
5. Keep a reconnect loop inside `start`/`stop` if the platform SDK does not; a rejected `start`
   is recorded as `lastError` and the channel shows `connected: false`.
6. Register the factory in `packages/redrob/src/channels/registry.ts` as a lazy constructor so
   the platform SDK loads only when the channel is enabled.

What the core gives back: the allowlist, the persisted session map, `/new` and `/status`, the
renderer, the daemon client attachment and the idle-exit override. A transport should be a
few hundred lines.
