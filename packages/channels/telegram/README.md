# @redrob-code/channels-telegram

Telegram transport for the Redrob Code chat channels (`docs/CHANNELS.md`). Built on
[grammY](https://grammy.dev) with long polling; no webhook, no public URL needed.

## Behaviour

- One Telegram chat is one conversation: `conversationId` is the chat id, `senderId` is the
  Telegram user id (what the allowlist holds; the first sender claims it, `redrob channels allow
  telegram <id>` adds more).
- Private chats: every text message is forwarded to the core.
- Groups and supergroups: only messages that mention the bot (`@YourBot`, `/new@YourBot`) or reply
  to one of its messages are forwarded; the mention is stripped before the core sees the text.
  Replies in groups quote the message that asked.
- Edits, joins, media without text and other bots are ignored.
- Replies are plain text, split by the core at 4096 characters (Telegram's limit), link previews
  off. A typing indicator is shown while the engine works.
- Reconnects are grammY's: the long poller retries on network errors until `stop()`.

## Secrets

| Key | Set with | Holds |
| --- | --- | --- |
| `botToken` | `redrob channels set-secret telegram botToken` | the token from @BotFather |

## Options (`channels.json` -> `channels.telegram.options`)

| Key | Default | Does |
| --- | --- | --- |
| `dropPendingUpdates` | `false` | discard messages received while the daemon was down instead of answering them on start |

## Setup

```sh
# @BotFather: /newbot, copy the token. For groups, /setprivacy -> Disable is NOT required:
# mentions and replies to the bot are delivered with privacy mode on.
redrob channels set-secret telegram botToken   # paste the token, Ctrl-D
redrob channels enable telegram
# message the bot within 15 minutes: the first message makes you its owner
# (redrob channels allow telegram <userId> adds more people later; @userinfobot tells you an id)
```

## Exports

```ts
import { TelegramTransport, telegramTransport, TELEGRAM_MAX_CHUNK, TELEGRAM_SECRETS } from "@redrob-code/channels-telegram"
```

`telegramTransport` is the `TransportFactory` the registry wires in.
