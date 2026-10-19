---
name: browser-notion
description: Use when the task is finding, reading or adding to a Notion page or database in the browser.
urls:
  - https://www.notion.so/*
  - https://*.notion.site/*
keywords:
  - notion
---

# Notion in the browser

Tools: `open_page`, `read_page`, `click`, `type_text`, and `login` when it is offered.

1. If the user gave a page link, `open_page` it directly. Otherwise open `https://www.notion.so`,
   `click` "Search", `type_text` the words into the search field, and `click` the matching result.
2. `read_page` returns the page's text in order, including database rows as table text. Notion
   loads long pages lazily: if the text stops mid-page, say so instead of guessing what follows.
3. To add text, `click` the empty line at the end of the page ("Type '/' for commands") and
   `type_text`. Edits save automatically, so only write what the user asked for.

Never delete pages, change sharing, or move pages between workspaces.
