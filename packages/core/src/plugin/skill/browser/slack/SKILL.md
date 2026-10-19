---
name: browser-slack
description: Use when the task is reading or searching Slack messages in the Slack web app in the browser.
urls:
  - https://app.slack.com/*
  - https://*.slack.com/*
keywords:
  - slack
---

# Slack web in the browser

Tools: `open_page`, `read_page`, `click`, `type_text`, and `login` when it is offered.

1. Open `https://app.slack.com/client`. If the page asks which workspace, `read_page` and ask the
   user which one when there is more than one.
2. To find messages, `click` the search bar at the top, `type_text` the words with modifiers
   (`in:#channel`, `from:@name`, `after:2026-10-01`, `has:link`), and press search.
3. `read_page` returns messages as author, time and text. Open a thread by clicking its
   "replies" link, then `read_page` again.
4. Writing: `type_text` into the message field of the channel or thread and STOP. Tell the user
   what is ready to send. Do not send, react, or start a huddle unless asked for that exact action.
