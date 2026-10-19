---
name: browser-github
description: Use when the task is reading issues, pull requests, releases or code on github.com in the browser.
urls:
  - https://github.com/*
keywords:
  - github
  - pull request
  - github issue
---

# GitHub in the browser

Tools: `open_page`, `read_page`, `click`, `type_text`, and `login` when it is offered.

1. Go straight to the page by URL instead of navigating:
   - issues: `https://github.com/<owner>/<repo>/issues?q=is:open+<words>`
   - pull requests: `https://github.com/<owner>/<repo>/pulls?q=is:open+author:<user>`
   - one item: `https://github.com/<owner>/<repo>/pull/<n>` (add `/files` for the diff)
   - releases: `https://github.com/<owner>/<repo>/releases`
   - search code: `https://github.com/search?q=<words>+repo:<owner>/<repo>&type=code`
2. `read_page` gives the title, state, labels and the conversation. For a long diff, read the
   files tab one file at a time.
3. Writing a comment: `click` the comment box, `type_text`, and stop before "Comment" unless the
   user asked you to post. Never merge, close, approve or push anything from the page.
