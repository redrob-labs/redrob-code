# @redrob-code/channels-discord

Discord transport for the Redrob Code chat channels (`@redrob-code/channels-core`). Talk to the
shared engine from a Discord DM, a guild text channel or a thread; each channel is one engine
session.

## Exports

- `class DiscordTransport implements Transport` -- `name = "discord"`, `maxChunk = 2000`.
- `const discordTransport: TransportFactory` -- `() => new DiscordTransport()`, what the CLI
  registry points at.
- `stripMention(content, userId)` -- removes the bot's `<@id>` mention from a guild message.
- `DISCORD_MAX_CHUNK` -- `2000`, Discord's message body limit.

## Behaviour

| | |
| --- | --- |
| `conversationId` | the Discord channel id: a DM channel, a guild channel, or a thread (threads have their own id) |
| `senderId` | the author's user id -- put this in the allowlist |
| `replyTo` | the inbound message id; the first chunk of the answer is sent as a reply to it |
| DMs | every message is delivered |
| Guild channels and threads | only messages that mention the bot (`@Redrob …`); the mention is stripped from the prompt |
| Ignored | the bot's own messages, other bots, system messages (joins, pins, boosts) |
| Typing | `sendTyping()` while the engine works |
| Reconnects | discord.js's gateway handles resume and reconnect; `start()` rejects on a bad token |

Gateway intents used: `Guilds`, `GuildMessages`, `DirectMessages`, `MessageContent`.

## Secrets

| Key | Value |
| --- | --- |
| `discord.botToken` | the bot token from the Developer Portal (Bot page, "Reset Token") |

```sh
redrob channels set-secret discord botToken     # paste the token, Ctrl-D
```

No non-secret `options` are read.

## Setting up the bot

1. [Discord Developer Portal](https://discord.com/developers/applications) -> New Application.
2. **Bot** page -> Reset Token, copy it -> `redrob channels set-secret discord botToken`.
3. **Bot** page -> *Privileged Gateway Intents* -> turn on **Message Content Intent**.
   This is required: without it Discord delivers guild messages with empty `content` and the bot
   sees nothing to answer. (Bots in fewer than 100 servers can enable it with a toggle; larger
   bots need Discord's approval.) *Server Members* and *Presence* are not needed.
4. **OAuth2** -> URL Generator: scope `bot`, permissions *View Channels*, *Send Messages*,
   *Send Messages in Threads*, *Read Message History*. Open the URL and add the bot to your server.
5. Switch the channel on and claim it:

```sh
redrob channels enable discord
# DM the bot (or mention it) within 15 minutes: the first message makes you its owner
# (redrob channels allow discord <userId> adds more people later; Developer Mode -> Copy User ID)
```

DM the bot, or mention it in a channel it can read. `/new`, `/status` and `/help` work as in every
other channel.
