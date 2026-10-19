---
name: browser-google-calendar
description: Use when the task is checking availability, listing events, or creating an event in Google Calendar in the browser.
urls:
  - https://calendar.google.com/*
keywords:
  - google calendar
  - my calendar
  - schedule a meeting
  - free slot
---

# Google Calendar in the browser

Tools: `open_page`, `read_page`, `click`, `type_text`, and `login` when it is offered.

1. Open a view by URL rather than clicking through the toolbar:
   - a day: `https://calendar.google.com/calendar/r/day/2026/10/19`
   - a week: `https://calendar.google.com/calendar/r/week/2026/10/19`
   - search: `https://calendar.google.com/calendar/r/search?q=<words>`
2. `read_page` returns each event as title, time and calendar. Report times in the user's own
   time zone as the page shows it; do not convert.
3. To create an event, open
   `https://calendar.google.com/calendar/r/eventedit?text=<title>&dates=20261020T100000/20261020T110000&details=<notes>`,
   `read_page` to confirm the fields, and stop before "Save" unless the user asked you to create it.
   Adding guests sends them invitations: ask first.

If the page is a sign-in form, use `login` if offered; otherwise ask the user to sign in.
