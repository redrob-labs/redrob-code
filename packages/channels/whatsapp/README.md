# @redrob-code/channels-whatsapp

The WhatsApp transport for Redrob Code channels (`docs/CHANNELS.md`), built on
[Baileys](https://github.com/WhiskeySockets/Baileys) `6.7.24`.

**Baileys is an unofficial client.** It speaks the WhatsApp Web protocol directly instead of the
WhatsApp Business API, which WhatsApp's terms do not permit for automation. Accounts running
unofficial clients can be, and sometimes are, **banned by WhatsApp without notice**. Use a number
you can afford to lose, keep the allowlist short, and do not use this transport to message people
who did not message you first.

## Pairing (no token)

There is no bot token and nothing to put in `secrets.json`. The daemon is linked to a WhatsApp
account as a *linked device* by scanning a QR code once:

```sh
redrob channels allow whatsapp 821012345678   # the phone number that may talk, digits only
redrob channels enable whatsapp
```

While the channel is not paired, `start()` still resolves and the transport exposes the QR code
three ways:

| Where | What |
| --- | --- |
| `transport.qr()` | the raw QR string, `undefined` once paired |
| `transport.qrDataUrl()` | the same as a `data:image/png;base64,...` URL |
| `~/.redrob/channels/whatsapp/qr.png` | the PNG on disk (mode 0600), removed once connected |

Open WhatsApp on the phone, *Linked devices* > *Link a device*, scan. WhatsApp rotates the QR
every ~20 seconds; the file and the getters follow. `transport.pairing()` is `"pairing"` while a
QR is waiting, `"paired"` once the socket is open, `"disconnected"` otherwise.

The pairing session (`creds.json` plus signal key files, written by Baileys'
`useMultiFileAuthState`) lives in `~/.redrob/channels/whatsapp/`, created `0700`, and is reused on
every start. When the phone unlinks the device (`loggedOut`), the files are deleted and a fresh QR
is produced. `REDROB_CHANNELS_HOME` moves the folder together with the other channel files.

## Settings

`channels.json` -> `channels.whatsapp.options` (all optional):

| Key | Default | Meaning |
| --- | --- | --- |
| `markOnlineOnConnect` | `false` | show the linked device as online; on, the phone stops getting notifications |
| `maxReconnectMs` | `30000` | ceiling of the exponential reconnect backoff |

Secrets: none. The channel reads nothing from `ctx.secrets`.

## Mapping

- `conversationId` = the chat's `remoteJid` (`<number>@s.whatsapp.net` for a direct chat,
  `<id>@g.us` for a group). One chat is one engine session.
- `senderId` = the sender's phone number without `@...` or device suffix (the group participant,
  or the chat itself in a direct chat). This is what the allowlist matches, e.g. `821012345678`.
  When WhatsApp delivers a LID (`@lid`) sender, the phone-number form it sends alongside is used.
- Dropped before reaching the core: the account's own messages (`fromMe`), status broadcasts and
  broadcast lists, history sync / offline backfill, and media without a caption.
- `maxChunk` is 4000; `typing()` sends a `composing` presence update.

## Exports

```ts
import { WhatsAppTransport, whatsappTransport, authDirectory, qrFile } from "@redrob-code/channels-whatsapp"
```

`whatsappTransport` is the `TransportFactory` the registry uses; `WhatsAppTransport` is the class
when a launcher wants `qr()` / `qrDataUrl()` / `paired()` / `pairing()`.
