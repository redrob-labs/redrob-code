/**
 * @redrob-code/channels-slack: the Slack transport for the channels core, plus the app manifest
 * that describes the Slack app it expects.
 */
export { SlackTransport, slackTransport, SLACK_MAX_CHUNK, conversationId, splitConversationId, stripMention } from "./transport"
export { manifestYaml, manifestUrl, SLACK_SCOPES, SLACK_EVENTS } from "./manifest"
