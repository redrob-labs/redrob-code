/**
 * The Slack app manifest for the Redrob bot: the one place the scopes and events the transport
 * needs are written down. `redrob channels slack-manifest` prints it; a user pastes it into
 * api.slack.com to create the app, or opens `manifestUrl()` which pre-fills the create page.
 *
 * Keep `SLACK_SCOPES` and `SLACK_EVENTS` in step with what `transport.ts` actually uses:
 * `app_mentions:read` + `app_mention` for mentions, `im:*` + `message.im` for direct messages,
 * `channels:history` + `message.channels` for channels the bot is a member of, `chat:write` to
 * reply, `users:read` to resolve sender names.
 */

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

export const manifestYaml: string = [
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

/** The api.slack.com "create an app" page with the manifest pre-filled. */
export function manifestUrl(): string {
  return `https://api.slack.com/apps?new_app=1&manifest_yaml=${encodeURIComponent(manifestYaml)}`
}
