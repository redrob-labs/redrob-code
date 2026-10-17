# @redrob-code/channels-slack

Slack transport for `@redrob-code/channels-core`: Bolt 3 in Socket Mode, so the daemon needs no
public URL. One Slack thread is one engine session.

## Secrets

Read at `start` from the channel secret store, never from the environment:

| Key | Value |
| --- | --- |
| `slack.botToken` | Bot user OAuth token, `xoxb-…` |
| `slack.appToken` | App-level token with `connections:write`, `xapp-…` |

```sh
redrob channels slack-manifest --url          # create the app from the manifest, install it
redrob channels set-secret slack botToken
redrob channels set-secret slack appToken
redrob channels enable slack
# DM the bot within 15 minutes: the first message makes you its owner
# (redrob channels allow slack <memberId> adds more people later)
```

No non-secret `options` are read yet.

## Behaviour

- Events: `app_mention`, `message.im`, `message.channels`. Messages with a `bot_id` or a
  `subtype` (edits, joins, bot posts) and the bot's own messages are dropped. A mention in a
  channel arrives as both `app_mention` and `message.channels`; it is delivered once.
- `conversationId` is `<channel>:<thread_ts ?? ts>`; replies go into that thread. The
  `<@bot>` token is stripped from the text before it reaches the core.
- `senderId` is the Slack user id (what the allowlist matches); `senderName` is filled from
  `users.info` when `users:read` is granted.
- `maxChunk` is 3900. No typing indicator: Slack has none for classic bots.
- `start` rejects on a bad bot token (`auth.test`) or a bad app token (socket open). Reconnects
  are Bolt's own.

## Exports

`SlackTransport`, `slackTransport` (factory), `SLACK_MAX_CHUNK`, `conversationId`,
`splitConversationId`, `stripMention`, and the manifest: `manifestYaml`, `manifestUrl()`,
`SLACK_SCOPES`, `SLACK_EVENTS`.
