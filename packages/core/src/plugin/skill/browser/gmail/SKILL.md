---
name: browser-gmail
description: Use when the task is reading, searching or drafting mail in Gmail in the browser. Covers the search box operators, opening a thread, and drafting a reply without sending it.
urls:
  - https://mail.google.com/*
keywords:
  - gmail
  - inbox
  - my email
---

# Gmail in the browser

Tools: `open_page`, `read_page`, `click`, `type_text`, and `login` when it is offered.

1. Open `https://mail.google.com/mail/u/0/#inbox` with `open_page`. If `read_page` shows a
   Google sign-in form, use `login` if it is offered; otherwise stop and ask the user to sign in.
   Never type a password yourself.
2. To find mail, `type_text` into the field labelled "Search mail", using operators:
   `from:name`, `to:`, `subject:`, `has:attachment`, `after:2026/01/31`, `is:unread`.
   Then `click` "Search" (or open `https://mail.google.com/mail/u/0/#search/<query>` directly).
3. `read_page` lists rows as sender, subject, snippet, date. `click` a subject to open the thread,
   then `read_page` again for the full text.
4. Replying: `click` "Reply", `type_text` into the message body, and STOP. Tell the user the draft
   is ready. Do not click "Send" unless the user asked for that exact message to be sent.

Do not delete, archive, mark as spam or change labels unless the user asked for it by name.
