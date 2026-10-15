/**
 * K-3: a real document toolchain in code mode — `docx`, `xlsx`, `pptx` and `pdf` as typed
 * globals in the same shape as K-1's `page`, each with a read half and a write half.
 *
 * The rule this module exists to keep: **a write produces a real file or it fails.** Every
 * `write` below serialises through a format library and lands bytes on disk at the path the
 * program asked for, and the result carries the byte count read back from that file. None of
 * them returns a stringified summary, and none of them reports success for a file it did not
 * write. Where a capability is genuinely absent the implementation THROWS and names what is
 * missing, exactly as `unavailablePage` does — see `unavailableDocuments`.
 *
 * Honest limits, stated here because they are properties of the formats and not bugs:
 *
 * - **`pdf.read` text is extracted from content streams, not rendered.** A page whose text is
 *   drawn with a composite (`Type0`) font carries glyph identifiers rather than characters, so
 *   that page's runs are SKIPPED and the page is returned with `textComplete: false` and a
 *   reason naming the font. A scanned page has no text operators at all and is reported the
 *   same way — there is no OCR in the engine process. Returning glyph soup as if it were text
 *   would be the fake-success this module refuses.
 * - **Simple-font text is decoded as Latin-1**, which equals WinAnsi for every codepoint the
 *   standard fonts place below 0x80 and differs only in the 0x80–0x9F band.
 * - OOXML reads (`docx`, `pptx`) take the text of the document part. They do not reconstruct
 *   styling, and `docx.read` does not descend into headers, footers or footnotes.
 */
import * as path from "path"
import * as fs from "node:fs/promises"
import { inflateSync } from "node:zlib"
import { Effect, Schema } from "effect"
import * as zip from "@zip.js/zip.js"
import { Tool as SandboxTool, toolError } from "@redrob-code/codemode"
import { DomainUnavailableError } from "./domain-error"

/**
 * A document operation that reached the format layer and failed there: a missing file, a file
 * that is not the container it claims to be, a library rejection. Distinct from
 * `DomainUnavailableError`, which says the capability is not present at all.
 */
export class DocumentFailureError extends Schema.TaggedErrorClass<DocumentFailureError>()(
  "CodeModeDocumentFailure",
  { object: Schema.String, operation: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `\`${this.object}.${this.operation}\` failed: ${this.reason}`
  }
}

/** Every document call fails with one of these two, and with nothing else. */
export type DocumentError = DocumentFailureError | DomainUnavailableError

const fail = (object: string, operation: string, reason: string) =>
  Effect.fail(new DocumentFailureError({ object, operation, reason }))

const attempt = <A>(object: string, operation: string, run: () => Promise<A> | A) =>
  Effect.tryPromise({
    try: async () => await run(),
    catch: (cause) =>
      new DocumentFailureError({
        object,
        operation,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  })

/* ------------------------------------------------------------------------------------------ */
/* The host: where a path resolves to and who is allowed to be asked about it                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * What the four objects need from the process they run in. Injected rather than imported so a
 * test drives real files in a temp directory and the preview path can supply nothing at all.
 *
 * `guard` is the permission hook: the engine wires it to the same external-directory check the
 * `write` tool uses, so a code-mode program cannot write a document outside the instance
 * directory without the user being asked.
 */
export interface DocumentHost {
  /** Directory a relative path is resolved against. */
  readonly directory: string
  /** Called with the resolved absolute path before any write. */
  readonly guard?: (filepath: string) => Effect.Effect<void, DocumentError>
}

const resolveRead = (host: DocumentHost, object: string, operation: string, filepath: string) =>
  Effect.gen(function* () {
    if (filepath.trim().length === 0) return yield* fail(object, operation, "an empty path is not a file")
    return path.isAbsolute(filepath) ? filepath : path.join(host.directory, filepath)
  })

const resolveWrite = (host: DocumentHost, object: string, operation: string, filepath: string) =>
  Effect.gen(function* () {
    const absolute = yield* resolveRead(host, object, operation, filepath)
    if (host.guard) yield* host.guard(absolute)
    return absolute
  })

const readBytes = (object: string, operation: string, absolute: string) =>
  Effect.gen(function* () {
    const stat = yield* Effect.tryPromise({
      try: () => fs.stat(absolute),
      catch: () => new DocumentFailureError({ object, operation, reason: `no file at ${absolute}` }),
    })
    if (!stat.isFile()) return yield* fail(object, operation, `${absolute} is not a file`)
    const buffer = yield* attempt(object, operation, () => fs.readFile(absolute))
    return new Uint8Array(buffer)
  })

/**
 * Writes the bytes, then STATS THE FILE and returns the size the filesystem reports. The
 * returned byte count is therefore a reading of the artefact, not of the buffer we hoped to
 * write — which is the difference between a verified write and a claimed one.
 */
const writeBytes = (object: string, operation: string, absolute: string, bytes: Uint8Array) =>
  Effect.gen(function* () {
    yield* attempt(object, operation, () => fs.mkdir(path.dirname(absolute), { recursive: true }))
    yield* attempt(object, operation, () => fs.writeFile(absolute, bytes))
    const stat = yield* attempt(object, operation, () => fs.stat(absolute))
    if (stat.size === 0) return yield* fail(object, operation, `wrote ${absolute} but it is empty`)
    return { path: absolute, bytes: stat.size }
  })

/* ------------------------------------------------------------------------------------------ */
/* OOXML: one zip reader for docx and pptx                                                      */
/* ------------------------------------------------------------------------------------------ */

// Web workers would outlive the test process and keep it alive; the archives here are small
// enough that inline inflation costs nothing.
zip.configure({ useWebWorkers: false })

/** Reads the named parts out of an OOXML package. Returns only the parts that exist. */
const readParts = (object: string, operation: string, bytes: Uint8Array, wanted: (name: string) => boolean) =>
  attempt(object, operation, async () => {
    const reader = new zip.ZipReader(new zip.Uint8ArrayReader(bytes))
    try {
      const entries = await reader.getEntries()
      if (entries.length === 0) throw new Error("not an OOXML package: the archive has no entries")
      const parts: Array<{ name: string; xml: string }> = []
      for (const entry of entries) {
        if (entry.directory || !wanted(entry.filename) || !entry.getData) continue
        parts.push({ name: entry.filename, xml: await entry.getData(new zip.TextWriter()) })
      }
      return parts
    } finally {
      await reader.close()
    }
  })

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

/** Decodes the XML entities an OOXML text node can carry, including numeric references. */
const decodeEntities = (text: string) =>
  text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return XML_ENTITIES[body] ?? whole
  })

/** The text of one OOXML run container, in document order, with tabs and breaks honoured. */
const runText = (fragment: string, textTag: string) => {
  let out = ""
  const pattern = new RegExp(`<${textTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${textTag}>|<(?:w|a):(tab|br)\\s*/>`, "g")
  for (const match of fragment.matchAll(pattern)) {
    if (match[1] !== undefined) out += decodeEntities(match[1])
    else if (match[2] === "tab") out += "\t"
    else out += "\n"
  }
  return out
}

/* ------------------------------------------------------------------------------------------ */
/* The four interfaces                                                                          */
/* ------------------------------------------------------------------------------------------ */

/** One paragraph a `docx.write` lays down. `heading` 1–6 renders as that heading level. */
export interface DocxParagraph {
  readonly text: string
  readonly heading?: number
  readonly bold?: boolean
}

export interface DocxResult {
  readonly path: string
  readonly bytes: number
}

/** Word documents. */
export interface Docx {
  /** Paragraph text of the document body, in document order. */
  readonly read: (input: {
    readonly path: string
  }) => Effect.Effect<{ readonly paragraphs: ReadonlyArray<string>; readonly text: string }, DocumentError>
  /** Writes a real `.docx` package and returns the path and the size on disk. */
  readonly write: (input: {
    readonly path: string
    readonly title?: string
    readonly paragraphs: ReadonlyArray<DocxParagraph>
  }) => Effect.Effect<DocxResult, DocumentError>
}

/** A spreadsheet cell as it crosses the sandbox boundary. */
export type CellValue = string | number | boolean | null

export interface XlsxSheet {
  readonly name: string
  readonly rows: ReadonlyArray<ReadonlyArray<CellValue>>
}

/** Excel workbooks. */
export interface Xlsx {
  /** Every sheet, or one named sheet, as rows of plain JSON cell values. */
  readonly read: (input: {
    readonly path: string
    readonly sheet?: string
  }) => Effect.Effect<{ readonly sheets: ReadonlyArray<XlsxSheet> }, DocumentError>
  /** Writes a real `.xlsx` workbook and returns the path and the size on disk. */
  readonly write: (input: {
    readonly path: string
    readonly sheets: ReadonlyArray<XlsxSheet>
  }) => Effect.Effect<DocxResult, DocumentError>
}

export interface PptxSlideRead {
  readonly index: number
  readonly text: ReadonlyArray<string>
}

export interface PptxSlideWrite {
  readonly title?: string
  readonly bullets?: ReadonlyArray<string>
  readonly notes?: string
}

/** PowerPoint decks. */
export interface Pptx {
  /** The text of every slide, slides in deck order. */
  readonly read: (input: {
    readonly path: string
  }) => Effect.Effect<{ readonly slides: ReadonlyArray<PptxSlideRead> }, DocumentError>
  /** Writes a real `.pptx` package and returns the path and the size on disk. */
  readonly write: (input: {
    readonly path: string
    readonly slides: ReadonlyArray<PptxSlideWrite>
  }) => Effect.Effect<DocxResult, DocumentError>
}

/**
 * One page of a `pdf.read`. `textComplete` is the honest field: false means some or all of the
 * page's text could not be recovered as characters, and `reason` says why.
 */
export interface PdfPageRead {
  readonly index: number
  readonly text: string
  readonly textComplete: boolean
  readonly reason?: string
}

/** PDF documents. */
export interface Pdf {
  /** Page count, document metadata, and per-page text with its completeness stated. */
  readonly read: (input: { readonly path: string }) => Effect.Effect<
    {
      readonly pageCount: number
      readonly title?: string
      readonly author?: string
      readonly pages: ReadonlyArray<PdfPageRead>
    },
    DocumentError
  >
  /** Writes a real `.pdf` and returns the path and the size on disk. */
  readonly write: (input: {
    readonly path: string
    readonly title?: string
    readonly fontSize?: number
    readonly pages: ReadonlyArray<{ readonly lines: ReadonlyArray<string> }>
  }) => Effect.Effect<DocxResult, DocumentError>
}

/** The four objects as one bundle, so the globals and the implementations cannot drift. */
export interface Documents {
  readonly docx: Docx
  readonly xlsx: Xlsx
  readonly pptx: Pptx
  readonly pdf: Pdf
}

/* ------------------------------------------------------------------------------------------ */
/* docx                                                                                         */
/* ------------------------------------------------------------------------------------------ */

const makeDocx = (host: DocumentHost): Docx => ({
  read: ({ path: filepath }) =>
    Effect.gen(function* () {
      const absolute = yield* resolveRead(host, "docx", "read", filepath)
      const bytes = yield* readBytes("docx", "read", absolute)
      const parts = yield* readParts("docx", "read", bytes, (name) => name === "word/document.xml")
      const body = parts[0]
      if (!body)
        return yield* fail("docx", "read", `${absolute} has no word/document.xml, so it is not a Word document`)
      const paragraphs: string[] = []
      for (const match of body.xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
        paragraphs.push(runText(match[1] ?? "", "w:t"))
      }
      return { paragraphs, text: paragraphs.join("\n") }
    }),
  write: ({ path: filepath, title, paragraphs }) =>
    Effect.gen(function* () {
      const absolute = yield* resolveWrite(host, "docx", "write", filepath)
      if (paragraphs.length === 0 && title === undefined)
        return yield* fail("docx", "write", "nothing to write: give at least a title or one paragraph")
      const bytes = yield* attempt("docx", "write", async () => {
        const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await import("docx")
        const levels = [
          HeadingLevel.HEADING_1,
          HeadingLevel.HEADING_2,
          HeadingLevel.HEADING_3,
          HeadingLevel.HEADING_4,
          HeadingLevel.HEADING_5,
          HeadingLevel.HEADING_6,
        ]
        const children = [
          ...(title === undefined ? [] : [new Paragraph({ text: title, heading: HeadingLevel.TITLE })]),
          ...paragraphs.map((paragraph) => {
            const level = paragraph.heading === undefined ? undefined : levels[Math.min(6, Math.max(1, paragraph.heading)) - 1]
            return new Paragraph({
              children: [new TextRun({ text: paragraph.text, bold: paragraph.bold === true })],
              ...(level ? { heading: level } : {}),
            })
          }),
        ]
        const document = new Document({ sections: [{ children }] })
        return new Uint8Array(await Packer.toBuffer(document))
      })
      return yield* writeBytes("docx", "write", absolute, bytes)
    }),
})

/* ------------------------------------------------------------------------------------------ */
/* xlsx                                                                                         */
/* ------------------------------------------------------------------------------------------ */

/** Projects one ExcelJS cell value onto the JSON shape the sandbox boundary allows. */
const cellValue = (value: unknown): CellValue => {
  if (value === null || value === undefined) return null
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  if (value instanceof Date) return value.toISOString()
  const record = value as Record<string, unknown>
  // A formula cell carries its cached result; a cell with no cached result is honestly null
  // rather than the formula text, which is not the cell's value.
  if ("result" in record) return cellValue(record["result"])
  if ("text" in record && typeof record["text"] === "string") return record["text"]
  if ("richText" in record && Array.isArray(record["richText"]))
    return (record["richText"] as Array<{ text?: string }>).map((run) => run.text ?? "").join("")
  if ("error" in record) return String(record["error"])
  if ("hyperlink" in record && typeof record["text"] === "string") return record["text"]
  return null
}

const makeXlsx = (host: DocumentHost): Xlsx => ({
  read: ({ path: filepath, sheet }) =>
    Effect.gen(function* () {
      const absolute = yield* resolveRead(host, "xlsx", "read", filepath)
      const bytes = yield* readBytes("xlsx", "read", absolute)
      const sheets = yield* attempt("xlsx", "read", async () => {
        const { default: ExcelJS } = await import("exceljs")
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(bytes as unknown as ArrayBuffer)
        const out: XlsxSheet[] = []
        workbook.eachSheet((worksheet) => {
          if (sheet !== undefined && worksheet.name !== sheet) return
          const rows: CellValue[][] = []
          worksheet.eachRow({ includeEmpty: true }, (row) => {
            // `row.values` is 1-indexed with a hole at 0; drop it rather than emitting a null
            // column nobody asked for.
            const values = Array.isArray(row.values) ? row.values.slice(1) : []
            rows.push(values.map(cellValue))
          })
          out.push({ name: worksheet.name, rows })
        })
        return out
      })
      if (sheet !== undefined && sheets.length === 0)
        return yield* fail("xlsx", "read", `${absolute} has no sheet named ${sheet}`)
      return { sheets }
    }),
  write: ({ path: filepath, sheets }) =>
    Effect.gen(function* () {
      const absolute = yield* resolveWrite(host, "xlsx", "write", filepath)
      if (sheets.length === 0) return yield* fail("xlsx", "write", "a workbook needs at least one sheet")
      const bytes = yield* attempt("xlsx", "write", async () => {
        const { default: ExcelJS } = await import("exceljs")
        const workbook = new ExcelJS.Workbook()
        for (const sheet of sheets) {
          const worksheet = workbook.addWorksheet(sheet.name)
          for (const row of sheet.rows) worksheet.addRow([...row])
        }
        const written = await workbook.xlsx.writeBuffer()
        return new Uint8Array(written as ArrayBuffer)
      })
      return yield* writeBytes("xlsx", "write", absolute, bytes)
    }),
})

/* ------------------------------------------------------------------------------------------ */
/* pptx                                                                                         */
/* ------------------------------------------------------------------------------------------ */

const SLIDE_PART = /^ppt\/slides\/slide(\d+)\.xml$/

const makePptx = (host: DocumentHost): Pptx => ({
  read: ({ path: filepath }) =>
    Effect.gen(function* () {
      const absolute = yield* resolveRead(host, "pptx", "read", filepath)
      const bytes = yield* readBytes("pptx", "read", absolute)
      const parts = yield* readParts("pptx", "read", bytes, (name) => SLIDE_PART.test(name))
      if (parts.length === 0)
        return yield* fail("pptx", "read", `${absolute} has no ppt/slides parts, so it is not a PowerPoint deck`)
      // Deck order is numeric, not lexical: slide10 comes after slide9, which a string sort
      // gets wrong for any deck past nine slides.
      const ordered = parts
        .map((part) => ({ part, number: Number.parseInt(SLIDE_PART.exec(part.name)![1]!, 10) }))
        .sort((a, b) => a.number - b.number)
      return {
        slides: ordered.map(({ part }, index) => {
          const text: string[] = []
          for (const match of part.xml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)) {
            const line = runText(match[1] ?? "", "a:t")
            if (line.length > 0) text.push(line)
          }
          return { index, text }
        }),
      }
    }),
  write: ({ path: filepath, slides }) =>
    Effect.gen(function* () {
      const absolute = yield* resolveWrite(host, "pptx", "write", filepath)
      if (slides.length === 0) return yield* fail("pptx", "write", "a deck needs at least one slide")
      const bytes = yield* attempt("pptx", "write", async () => {
        const { default: PptxGenJS } = await import("pptxgenjs")
        const deck = new PptxGenJS()
        for (const input of slides) {
          const slide = deck.addSlide()
          if (input.title !== undefined)
            slide.addText(input.title, { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 28, bold: true })
          const bullets = input.bullets ?? []
          if (bullets.length > 0)
            slide.addText(
              bullets.map((text) => ({ text, options: { bullet: true, fontSize: 16, breakLine: true } })),
              { x: 0.7, y: 1.5, w: 8.6, h: 4.5 },
            )
          if (input.notes !== undefined) slide.addNotes(input.notes)
        }
        const written = await deck.write({ outputType: "nodebuffer" })
        return new Uint8Array(written as ArrayBuffer)
      })
      return yield* writeBytes("pptx", "write", absolute, bytes)
    }),
})

/* ------------------------------------------------------------------------------------------ */
/* pdf                                                                                          */
/* ------------------------------------------------------------------------------------------ */

/** A PDF literal or hex string, read from a content stream as raw byte codes. */
const readPdfString = (source: string, start: number): { value: string; next: number } | undefined => {
  if (source[start] === "(") {
    let depth = 1
    let index = start + 1
    let out = ""
    while (index < source.length) {
      const char = source[index]!
      if (char === "\\") {
        const escaped = source[index + 1]
        index += 2
        switch (escaped) {
          case "n":
            out += "\n"
            break
          case "r":
            out += "\r"
            break
          case "t":
            out += "\t"
            break
          case "b":
          case "f":
            break
          case "\n":
            break
          default:
            if (escaped !== undefined && escaped >= "0" && escaped <= "7") {
              let octal = escaped
              while (octal.length < 3 && source[index] !== undefined && source[index]! >= "0" && source[index]! <= "7") {
                octal += source[index]!
                index += 1
              }
              out += String.fromCharCode(Number.parseInt(octal, 8))
            } else if (escaped !== undefined) out += escaped
        }
        continue
      }
      if (char === "(") depth += 1
      if (char === ")") {
        depth -= 1
        if (depth === 0) return { value: out, next: index + 1 }
      }
      out += char
      index += 1
    }
    return undefined
  }
  if (source[start] === "<" && source[start + 1] !== "<") {
    const end = source.indexOf(">", start + 1)
    if (end < 0) return undefined
    const hex = source.slice(start + 1, end).replace(/[^0-9a-fA-F]/g, "")
    let out = ""
    for (let index = 0; index + 1 < hex.length; index += 2)
      out += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16))
    return { value: out, next: end + 1 }
  }
  return undefined
}

type Operand = { readonly kind: "string"; readonly value: string } | { readonly kind: "name"; readonly value: string } | { readonly kind: "other" }

/**
 * Walks a decoded content stream and returns the text it shows, plus the names of any fonts
 * whose runs were skipped because their codes are not characters.
 *
 * The scan is an operand stack cleared at every operator, which is what a PDF content stream
 * is: postfix operands followed by an operator. `Tf` sets the current font, and a run drawn in
 * a font this function cannot decode is dropped and recorded rather than guessed at.
 */
export const extractPdfText = (
  content: string,
  decodable: (font: string) => boolean,
): { text: string; skipped: ReadonlyArray<string> } => {
  const lines: string[] = []
  let current = ""
  let font: string | undefined
  const skipped = new Set<string>()
  let operands: Operand[] = []
  let index = 0

  const breakLine = () => {
    lines.push(current)
    current = ""
  }
  const show = (value: string) => {
    if (font !== undefined && !decodable(font)) {
      skipped.add(font)
      return
    }
    current += value
  }

  while (index < content.length) {
    const char = content[index]!
    if (char === "(" || (char === "<" && content[index + 1] !== "<")) {
      const read = readPdfString(content, index)
      if (!read) break
      operands.push({ kind: "string", value: read.value })
      index = read.next
      continue
    }
    if (char === "<" || char === ">") {
      index += content[index + 1] === char ? 2 : 1
      continue
    }
    if (char === "/") {
      const match = /^\/([^\s/[\]<>(){}]*)/.exec(content.slice(index))!
      operands.push({ kind: "name", value: match[1] ?? "" })
      index += match[0].length
      continue
    }
    if (char === "[" || char === "]") {
      index += 1
      continue
    }
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    const token = /^[^\s/[\]<>(){}]+/.exec(content.slice(index))?.[0]
    if (!token) {
      index += 1
      continue
    }
    index += token.length
    if (/^[-+.\d]/.test(token)) {
      operands.push({ kind: "other" })
      continue
    }
    switch (token) {
      case "Tf": {
        const name = operands.findLast((operand) => operand.kind === "name")
        if (name && name.kind === "name") font = name.value
        break
      }
      case "Tj":
      case "TJ": {
        for (const operand of operands) if (operand.kind === "string") show(operand.value)
        break
      }
      case "'":
      case '"': {
        breakLine()
        for (const operand of operands) if (operand.kind === "string") show(operand.value)
        break
      }
      case "Td":
      case "TD":
      case "T*":
      case "TL":
      case "Tm":
      case "ET":
        if (current.length > 0) breakLine()
        break
      default:
        break
    }
    operands = []
  }
  if (current.length > 0) lines.push(current)
  return { text: lines.join("\n"), skipped: [...skipped] }
}

const makePdf = (host: DocumentHost): Pdf => ({
  read: ({ path: filepath }) =>
    Effect.gen(function* () {
      const absolute = yield* resolveRead(host, "pdf", "read", filepath)
      const bytes = yield* readBytes("pdf", "read", absolute)
      return yield* attempt("pdf", "read", async () => {
        const { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } = await import("pdf-lib")
        const document = await PDFDocument.load(bytes, { updateMetadata: false })
        const pages: PdfPageRead[] = []
        document.getPages().forEach((page, index) => {
          // A composite font's string bytes are glyph ids in the font's own space, so they are
          // not text and are not treated as text. Everything else is a simple font whose codes
          // are character codes.
          const composite = new Set<string>()
          const resources = page.node.get(PDFName.of("Resources"))
          const fonts =
            resources instanceof PDFDict ? document.context.lookupMaybe(resources.get(PDFName.of("Font")), PDFDict) : undefined
          if (fonts)
            for (const [name, ref] of fonts.entries()) {
              const font = document.context.lookupMaybe(ref, PDFDict)
              const subtype = font?.get(PDFName.of("Subtype"))
              if (subtype !== undefined && String(subtype) === "/Type0") composite.add(name.asString().slice(1))
            }

          const contents = page.node.get(PDFName.of("Contents"))
          const refs =
            contents instanceof PDFArray
              ? contents.asArray()
              : contents === undefined
                ? []
                : [contents]
          let decoded = ""
          for (const ref of refs) {
            const looked = document.context.lookup(ref)
            if (!(looked instanceof PDFRawStream)) continue
            const stream = looked
            const raw = Buffer.from(stream.getContents())
            const filter = stream.dict.get(PDFName.of("Filter"))
            const flate = filter !== undefined && String(filter).includes("FlateDecode")
            decoded += flate ? inflateSync(raw).toString("latin1") : raw.toString("latin1")
          }
          if (decoded.length === 0) {
            pages.push({
              index,
              text: "",
              textComplete: false,
              reason:
                "the page has no readable content stream: it is an image-only or scanned page, and the engine process has no OCR",
            })
            return
          }
          const { text, skipped } = extractPdfText(decoded, (font) => !composite.has(font))
          if (skipped.length > 0) {
            pages.push({
              index,
              text,
              textComplete: false,
              reason: `text drawn with composite (Type0) font${skipped.length === 1 ? "" : "s"} ${skipped.join(", ")} was skipped: those strings are glyph identifiers, not characters, and no ToUnicode mapping is applied`,
            })
            return
          }
          if (text.length === 0) {
            pages.push({
              index,
              text: "",
              textComplete: false,
              reason: "the content stream shows no text: the page draws only graphics",
            })
            return
          }
          pages.push({ index, text, textComplete: true })
        })
        const title = document.getTitle()
        const author = document.getAuthor()
        return {
          pageCount: document.getPageCount(),
          ...(title ? { title } : {}),
          ...(author ? { author } : {}),
          pages,
        }
      })
    }),
  write: ({ path: filepath, title, fontSize, pages }) =>
    Effect.gen(function* () {
      const absolute = yield* resolveWrite(host, "pdf", "write", filepath)
      if (pages.length === 0) return yield* fail("pdf", "write", "a PDF needs at least one page")
      const size = fontSize ?? 12
      if (!Number.isFinite(size) || size <= 0) return yield* fail("pdf", "write", `fontSize ${fontSize} is not a size`)
      const bytes = yield* attempt("pdf", "write", async () => {
        const { PDFDocument, StandardFonts } = await import("pdf-lib")
        const document = await PDFDocument.create()
        if (title !== undefined) document.setTitle(title)
        const font = await document.embedFont(StandardFonts.Helvetica)
        const [width, height] = [595.28, 841.89] // A4 at 72dpi, the size a reader expects
        const margin = 56
        const leading = size * 1.45
        for (const input of pages) {
          let page = document.addPage([width, height])
          let cursor = height - margin
          for (const line of input.lines) {
            // A page that runs out of room continues onto a new one rather than silently
            // dropping the rest of the text.
            if (cursor < margin) {
              page = document.addPage([width, height])
              cursor = height - margin
            }
            // WinAnsi is what the standard 14 fonts encode; a character outside it would make
            // pdf-lib throw, so it is replaced rather than failing the whole write.
            const drawable = [...line].map((char) => (char.codePointAt(0)! > 0xff ? "?" : char)).join("")
            page.drawText(drawable, { x: margin, y: cursor, size, font })
            cursor -= leading
          }
        }
        return new Uint8Array(await document.save())
      })
      return yield* writeBytes("pdf", "write", absolute, bytes)
    }),
})

/* ------------------------------------------------------------------------------------------ */
/* The two implementations: the real one, and the one that refuses                              */
/* ------------------------------------------------------------------------------------------ */

/** The working implementation, bound to a directory and an optional permission guard. */
export const documents = (host: DocumentHost): Documents => ({
  docx: makeDocx(host),
  xlsx: makeXlsx(host),
  pptx: makePptx(host),
  pdf: makePdf(host),
})

/**
 * The refusing implementation, for the catalog preview — which describes the globals without
 * being a live execution and so has no directory to resolve a path against. Same discipline as
 * `unavailablePage`: every method fails with the reason named, and none of them returns a
 * plausible value or a fake success.
 */
export const unavailableDocuments = (missing = "this is a catalog preview, not a live execution"): Documents => {
  const refuse = <A>(object: string) =>
    Effect.fail(new DomainUnavailableError({ object, missing })) as Effect.Effect<A, DomainUnavailableError>
  return {
    docx: { read: () => refuse("docx"), write: () => refuse("docx") },
    xlsx: { read: () => refuse("xlsx"), write: () => refuse("xlsx") },
    pptx: { read: () => refuse("pptx"), write: () => refuse("pptx") },
    pdf: { read: () => refuse("pdf"), write: () => refuse("pdf") },
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Code Mode namespaces                                                                         */
/* ------------------------------------------------------------------------------------------ */

const PathInput = Schema.String.annotate({
  description: "Path to the file. Relative paths resolve against the instance directory.",
})

const WriteResult = Schema.Struct({
  path: Schema.String,
  bytes: Schema.Number,
}).annotate({ description: "The absolute path written and the size the filesystem reports for it." })

const CellSchema = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])

const SheetSchema = Schema.Struct({
  name: Schema.String.annotate({ description: "Sheet name." }),
  rows: Schema.Array(Schema.Array(CellSchema)).annotate({ description: "Rows of cell values, top-left first." }),
})

/**
 * Lifts a document call into a Code Mode tool. Both error kinds carry a sentence, so an
 * unavailable object and a format failure read as precise refusals in the program rather than
 * as an opaque execution failure.
 */
const lift =
  <I, A>(call: (input: I) => Effect.Effect<A, DocumentError>) =>
  (input: I) =>
    call(input).pipe(Effect.mapError((error) => toolError(error.message, error)))

export const docxTools = (docx: Docx) => ({
  read: SandboxTool.make({
    description: "Paragraph text of a Word document, in document order.",
    input: Schema.Struct({ path: PathInput }),
    output: Schema.Struct({ paragraphs: Schema.Array(Schema.String), text: Schema.String }),
    run: lift((input: { path: string }) => docx.read(input)),
  }),
  write: SandboxTool.make({
    description: "Write a real .docx file. Returns the path written and its size on disk.",
    input: Schema.Struct({
      path: PathInput,
      title: Schema.optionalKey(Schema.String.annotate({ description: "Document title paragraph." })),
      paragraphs: Schema.Array(
        Schema.Struct({
          text: Schema.String,
          heading: Schema.optionalKey(Schema.Number.annotate({ description: "Heading level 1-6." })),
          bold: Schema.optionalKey(Schema.Boolean),
        }),
      ),
    }),
    output: WriteResult,
    run: lift(
      (input: { path: string; title?: string; paragraphs: ReadonlyArray<DocxParagraph> }) => docx.write(input),
    ),
  }),
})

export const xlsxTools = (xlsx: Xlsx) => ({
  read: SandboxTool.make({
    description: "Rows of an Excel workbook as plain cell values, every sheet or one named sheet.",
    input: Schema.Struct({
      path: PathInput,
      sheet: Schema.optionalKey(Schema.String.annotate({ description: "Read only this sheet." })),
    }),
    output: Schema.Struct({ sheets: Schema.Array(SheetSchema) }),
    run: lift((input: { path: string; sheet?: string }) => xlsx.read(input)),
  }),
  write: SandboxTool.make({
    description: "Write a real .xlsx workbook. Returns the path written and its size on disk.",
    input: Schema.Struct({ path: PathInput, sheets: Schema.Array(SheetSchema) }),
    output: WriteResult,
    run: lift((input: { path: string; sheets: ReadonlyArray<XlsxSheet> }) => xlsx.write(input)),
  }),
})

export const pptxTools = (pptx: Pptx) => ({
  read: SandboxTool.make({
    description: "The text of every slide in a PowerPoint deck, in deck order.",
    input: Schema.Struct({ path: PathInput }),
    output: Schema.Struct({
      slides: Schema.Array(Schema.Struct({ index: Schema.Number, text: Schema.Array(Schema.String) })),
    }),
    run: lift((input: { path: string }) => pptx.read(input)),
  }),
  write: SandboxTool.make({
    description: "Write a real .pptx deck. Returns the path written and its size on disk.",
    input: Schema.Struct({
      path: PathInput,
      slides: Schema.Array(
        Schema.Struct({
          title: Schema.optionalKey(Schema.String),
          bullets: Schema.optionalKey(Schema.Array(Schema.String)),
          notes: Schema.optionalKey(Schema.String.annotate({ description: "Speaker notes." })),
        }),
      ),
    }),
    output: WriteResult,
    run: lift((input: { path: string; slides: ReadonlyArray<PptxSlideWrite> }) => pptx.write(input)),
  }),
})

export const pdfTools = (pdf: Pdf) => ({
  read: SandboxTool.make({
    description:
      "Page count, metadata and per-page text of a PDF. `textComplete` is false with a reason where text could not be recovered as characters.",
    input: Schema.Struct({ path: PathInput }),
    output: Schema.Struct({
      pageCount: Schema.Number,
      title: Schema.optionalKey(Schema.String),
      author: Schema.optionalKey(Schema.String),
      pages: Schema.Array(
        Schema.Struct({
          index: Schema.Number,
          text: Schema.String,
          textComplete: Schema.Boolean,
          reason: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
    run: lift((input: { path: string }) => pdf.read(input)),
  }),
  write: SandboxTool.make({
    description: "Write a real .pdf. Lines are laid out in Helvetica and overflow onto new pages.",
    input: Schema.Struct({
      path: PathInput,
      title: Schema.optionalKey(Schema.String),
      fontSize: Schema.optionalKey(Schema.Number.annotate({ description: "Point size, default 12." })),
      pages: Schema.Array(Schema.Struct({ lines: Schema.Array(Schema.String) })),
    }),
    output: WriteResult,
    run: lift(
      (input: {
        path: string
        title?: string
        fontSize?: number
        pages: ReadonlyArray<{ lines: ReadonlyArray<string> }>
      }) => pdf.write(input),
    ),
  }),
})

/** The global names K-3 adds, in the order they are declared. */
export const DOCUMENT_GLOBALS = ["docx", "pdf", "pptx", "xlsx"] as const

/** The four namespaces keyed by the global each is bound to. */
export const documentTools = (input: Documents) => ({
  docx: docxTools(input.docx),
  pdf: pdfTools(input.pdf),
  pptx: pptxTools(input.pptx),
  xlsx: xlsxTools(input.xlsx),
})
