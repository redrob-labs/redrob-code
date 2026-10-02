<!--
  K-3 built-in skill. Its name, description and auto-arm block are registered in code at
  packages/core/src/plugin/skill.ts; the body below becomes the skill's content.

  Every API claim in this document is asserted against the real tool tree by
  packages/redrob/test/tool/document-skill.test.ts. If you change a method name, a field name
  or a global name here, that test fails until the code agrees.
-->

# Reading and writing documents in code mode

Code mode binds four document objects as bare globals: `docx`, `xlsx`, `pptx` and `pdf`.
Each has exactly two methods, `read` and `write`. They are part of the language, not an MCP
server, so they are there whether or not anything is connected.

**A `write` produces a real file.** It serialises through a format library, lands bytes on
disk, and returns `{ path, bytes }` where `bytes` is the size the filesystem reports for the
file that is now there. There is no mode in which a write returns a summary of a document it
did not produce. If a write cannot be done it throws and says why.

Paths may be relative — they resolve against the instance directory — or absolute. Writing
outside the instance directory asks the user for permission first, and a refusal throws
rather than writing somewhere else.

## docx — Word

```js
const back = await docx.read({ path: "report.docx" })
// => { paragraphs: string[], text: string }

await docx.write({
  path: "report.docx",
  title: "Quarterly report",
  paragraphs: [
    { text: "Revenue grew.", heading: 1 },
    { text: "Costs held flat.", bold: true },
    { text: "Headcount unchanged." },
  ],
})
// => { path: "/abs/report.docx", bytes: 9445 }
```

`read` returns the body's paragraph text in document order, and `text` is those paragraphs
joined with newlines. It does not reconstruct styling, and it does not descend into headers,
footers or footnotes — so a paragraph that only exists in a header will not appear.

`heading` is a level from 1 to 6. `title` is optional and renders as the document title.

## xlsx — Excel

```js
const book = await xlsx.read({ path: "numbers.xlsx" })
// => { sheets: [{ name: "Totals", rows: [["region", "units"], ["EMEA", 1200]] }] }

const one = await xlsx.read({ path: "numbers.xlsx", sheet: "Totals" })

await xlsx.write({
  path: "numbers.xlsx",
  sheets: [{ name: "Totals", rows: [["region", "units"], ["EMEA", 1200]] }],
})
```

Cells come back as strings, numbers, booleans or `null`. A date becomes an ISO 8601 string.
A formula cell gives its cached result, and `null` when the file carries no cached result —
never the formula text, which is not the cell's value. Naming a `sheet` that does not exist
throws instead of returning an empty list.

## pptx — PowerPoint

```js
const deck = await pptx.read({ path: "deck.pptx" })
// => { slides: [{ index: 0, text: ["Slide 1", "point 1a"] }] }

await pptx.write({
  path: "deck.pptx",
  slides: [{ title: "Findings", bullets: ["One", "Two"], notes: "say it slowly" }],
})
```

`read` gives the text of each slide in deck order, `index` counting from zero. It reads the
slides themselves, not layouts or masters, so boilerplate that lives on a master is absent.

## pdf — PDF

```js
const doc = await pdf.read({ path: "brief.pdf" })
// => { pageCount, title?, author?, pages: [{ index, text, textComplete, reason? }] }

await pdf.write({
  path: "brief.pdf",
  title: "Engine brief",
  fontSize: 12,
  pages: [{ lines: ["First line", "Second line"] }],
})
```

`pdf.write` works: it produces a real PDF, one page per entry, lines laid out in Helvetica,
and a page that runs out of room continues onto a new one rather than dropping text. A
character outside WinAnsi is written as `?`, because the standard fonts cannot encode it.

**`pdf.read` extracts text from content streams; it does not render the page.** Read
`textComplete` before you trust `text`:

- `textComplete: true` — the page's text was recovered as characters.
- `textComplete: false` with a `reason` — some or all of it could not be. The three reasons
  are a page whose text is drawn with a composite (`Type0`) font, where the string bytes are
  glyph identifiers rather than characters and are therefore skipped; a page with no readable
  content stream, which is a scan or an image and there is no OCR in the engine; and a page
  that draws only graphics.

A page reported `textComplete: false` has not been read. Say so to the user instead of
treating its `text` as the page's content.

## When a document call fails

Both failure kinds throw with a sentence naming the object and the operation:

- `` `docx.read` failed: no file at /abs/absent.docx `` — the call reached the format layer
  and that layer refused. Wrong path, wrong container, a library rejection.
- `` The `pdf` domain object is not available in this session: … `` — the capability itself is
  absent. This is what a catalog preview returns, because a preview has no directory to
  resolve a path against and is not a live execution.

Neither is recoverable by retrying the same call. Report the sentence; do not substitute a
plausible value for a document you could not read.
