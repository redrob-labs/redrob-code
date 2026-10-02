import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { Tool } from "@/tool/tool"
import * as Truncate from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import { InstanceRef } from "@/effect/instance-ref"
import { CodeModeTool, describeCatalog } from "@/tool/code-mode"
import {
  DOCUMENT_GLOBALS,
  DocumentFailureError,
  documentTools,
  documents,
  extractPdfText,
  unavailableDocuments,
  type DocumentError,
} from "@/tool/document"
import { DomainUnavailableError } from "@/tool/domain-error"
import { DOMAIN_GLOBALS, domainTools, unavailableChannel, unavailablePage } from "@/tool/domain"

let directory: string

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "redrob-k3-"))
})

afterAll(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

/** The real implementation, rooted at the temp directory, with no permission guard. */
const docs = () => documents({ directory })

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

/** Runs an effect expected to fail and returns the error it failed with. */
const errorOf = async <A, E>(effect: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromise(effect.pipe(Effect.exit))
  if (Exit.isSuccess(exit)) throw new Error("expected the call to fail")
  return Cause.squash(exit.cause) as Error
}

/** The first bytes of a file, so a write is asserted on the artefact's own magic number. */
const magic = async (file: string, length: number) => {
  const bytes = await fs.readFile(file)
  return bytes.subarray(0, length).toString("latin1")
}

const sessionID = SessionID.make("ses_document")
const messageID = MessageID.make("msg_document")

const toolContext: Tool.Context = {
  sessionID,
  messageID,
  agent: "build",
  abort: new AbortController().signal,
  callID: "call_document",
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

/**
 * Runs one Code Mode program through the REAL `execute` tool with an instance bound to
 * `directory`, so the document globals the program calls are the ones the engine wires and the
 * files it writes land where the engine would put them.
 */
const runProgram = (code: string, directory: string) =>
  Effect.runPromise(
    CodeModeTool.pipe(
      Effect.flatMap(Tool.init),
      Effect.flatMap((def) => def.execute({ code }, toolContext)),
      Effect.provideService(InstanceRef, {
        directory,
        worktree: directory,
        project: {} as never,
      }),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Plugin.Service, {
            trigger: ((_name, _input, output) => Effect.succeed(output)) as Plugin.Interface["trigger"],
          }),
          Layer.mock(Truncate.Service, {
            output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
          }),
          Layer.mock(Agent.Service, { get: () => Effect.succeed({ name: "build", permission: [] } as never) }),
          Layer.mock(Session.Service, {
            get: () => Effect.succeed({ permission: [] } as never),
            updatePart: (part: unknown) => Effect.succeed(part as never),
          } as never),
          Layer.mock(MCP.Service, { tools: () => Effect.succeed({}), clients: () => Effect.succeed({}) }),
        ),
      ),
    ),
  )

describe("K-3 document toolchain", () => {
  test("every document global names a namespace, and the domain bundle carries all six", () => {
    const tools = domainTools({ page: unavailablePage(), channel: unavailableChannel() })
    expect([...(DOMAIN_GLOBALS as ReadonlyArray<string>)].toSorted()).toStrictEqual(Object.keys(tools).toSorted())
    for (const name of DOCUMENT_GLOBALS) expect(Object.keys(tools)).toContain(name)
    expect(Object.keys(documentTools(unavailableDocuments())).toSorted()).toStrictEqual([
      "docx",
      "pdf",
      "pptx",
      "xlsx",
    ])
  })

  test("each document namespace exposes exactly read and write", () => {
    const tools = documentTools(unavailableDocuments())
    for (const name of DOCUMENT_GLOBALS) {
      expect(Object.keys(tools[name]).toSorted()).toStrictEqual(["read", "write"])
    }
  })

  test("the globals are advertised in the catalog description a model reads", () => {
    const instructions = describeCatalog({}, [])
    for (const name of DOCUMENT_GLOBALS) expect(instructions).toContain(`\`${name}\``)
  })

  describe("docx", () => {
    test("write lands a real OOXML package and read recovers its paragraphs", async () => {
      const file = path.join(directory, "report.docx")
      const written = await run(
        docs().docx.write({
          path: "report.docx",
          title: "Quarterly report",
          paragraphs: [
            { text: "Revenue grew.", heading: 1 },
            { text: "Costs held flat.", bold: true },
            { text: "Headcount unchanged." },
          ],
        }),
      )
      expect(written.path).toBe(file)
      // The size is read back off the filesystem, so this asserts the artefact, not the buffer.
      const stat = await fs.stat(file)
      expect(written.bytes).toBe(stat.size)
      expect(written.bytes).toBeGreaterThan(1000)
      expect(await magic(file, 2)).toBe("PK")

      const read = await run(docs().docx.read({ path: file }))
      expect(read.paragraphs).toContain("Quarterly report")
      expect(read.paragraphs).toContain("Revenue grew.")
      expect(read.paragraphs).toContain("Costs held flat.")
      expect(read.paragraphs).toContain("Headcount unchanged.")
      expect(read.text).toContain("Revenue grew.\nCosts held flat.")
    })

    test("text that needs XML escaping survives the round trip", async () => {
      const file = path.join(directory, "escapes.docx")
      await run(
        docs().docx.write({ path: file, paragraphs: [{ text: 'a < b & c > d "quoted" \u2014 dash' }] }),
      )
      const read = await run(docs().docx.read({ path: file }))
      expect(read.paragraphs).toContain('a < b & c > d "quoted" \u2014 dash')
    })

    test("reading a file that is not a Word document fails naming the missing part", async () => {
      const file = path.join(directory, "not-really.docx")
      await fs.writeFile(file, "plain text, no zip here")
      const error = await errorOf(docs().docx.read({ path: file }))
      expect(error).toBeInstanceOf(DocumentFailureError)
      expect(error.message).toStartWith("`docx.read` failed:")
    })

    test("reading a missing file names the path rather than returning empty text", async () => {
      const error = await errorOf(docs().docx.read({ path: "absent.docx" }))
      expect(error.message).toContain("no file at")
      expect(error.message).toContain("absent.docx")
    })

    test("a write with nothing in it is refused instead of producing an empty document", async () => {
      const error = await errorOf(docs().docx.write({ path: "empty.docx", paragraphs: [] }))
      expect(error.message).toContain("nothing to write")
      expect(await fs.exists(path.join(directory, "empty.docx"))).toBe(false)
    })
  })

  describe("xlsx", () => {
    test("write lands a real workbook and read recovers typed cells", async () => {
      const file = path.join(directory, "numbers.xlsx")
      const written = await run(
        docs().xlsx.write({
          path: "numbers.xlsx",
          sheets: [
            { name: "Totals", rows: [["region", "units", "active"], ["EMEA", 1200, true], ["APAC", 980.5, false]] },
            { name: "Notes", rows: [["only one row"]] },
          ],
        }),
      )
      expect(written.bytes).toBe((await fs.stat(file)).size)
      expect(await magic(file, 2)).toBe("PK")

      const read = await run(docs().xlsx.read({ path: file }))
      expect(read.sheets.map((sheet) => sheet.name)).toStrictEqual(["Totals", "Notes"])
      expect(read.sheets[0]!.rows[0]).toStrictEqual(["region", "units", "active"])
      expect(read.sheets[0]!.rows[1]).toStrictEqual(["EMEA", 1200, true])
      expect(read.sheets[0]!.rows[2]).toStrictEqual(["APAC", 980.5, false])
      expect(read.sheets[1]!.rows).toStrictEqual([["only one row"]])
    })

    test("read can be scoped to one sheet, and an absent sheet name is an error not an empty list", async () => {
      const file = path.join(directory, "numbers.xlsx")
      const one = await run(docs().xlsx.read({ path: file, sheet: "Notes" }))
      expect(one.sheets).toHaveLength(1)
      expect(one.sheets[0]!.name).toBe("Notes")
      const error = await errorOf(docs().xlsx.read({ path: file, sheet: "Nope" }))
      expect(error.message).toContain("no sheet named Nope")
    })

    test("a workbook with no sheets is refused", async () => {
      const error = await errorOf(docs().xlsx.write({ path: "nothing.xlsx", sheets: [] }))
      expect(error.message).toContain("at least one sheet")
      expect(await fs.exists(path.join(directory, "nothing.xlsx"))).toBe(false)
    })
  })

  describe("pptx", () => {
    test("write lands a real deck and read recovers slide text in deck order", async () => {
      const file = path.join(directory, "deck.pptx")
      // Twelve slides on purpose: slide10 sorts before slide9 lexically, so a deck past nine
      // slides is the only thing that catches a string sort of the slide parts.
      const slides = Array.from({ length: 12 }, (_, index) => ({
        title: `Slide ${index + 1}`,
        bullets: [`point ${index + 1}a`, `point ${index + 1}b`],
        notes: `notes ${index + 1}`,
      }))
      const written = await run(docs().pptx.write({ path: "deck.pptx", slides }))
      expect(written.bytes).toBe((await fs.stat(file)).size)
      expect(await magic(file, 2)).toBe("PK")

      const read = await run(docs().pptx.read({ path: file }))
      expect(read.slides).toHaveLength(12)
      expect(read.slides.map((slide) => slide.index)).toStrictEqual([...Array(12).keys()])
      expect(read.slides[0]!.text.join("\n")).toContain("Slide 1")
      expect(read.slides[8]!.text.join("\n")).toContain("Slide 9")
      expect(read.slides[9]!.text.join("\n")).toContain("Slide 10")
      expect(read.slides[11]!.text.join("\n")).toContain("point 12b")
    })

    test("reading a package with no slide parts fails naming what is missing", async () => {
      const docx = path.join(directory, "report.docx")
      const error = await errorOf(docs().pptx.read({ path: docx }))
      expect(error.message).toContain("no ppt/slides parts")
    })

    test("a deck with no slides is refused", async () => {
      const error = await errorOf(docs().pptx.write({ path: "nothing.pptx", slides: [] }))
      expect(error.message).toContain("at least one slide")
    })
  })

  describe("pdf", () => {
    test("write lands a real PDF and read recovers its text and metadata", async () => {
      const file = path.join(directory, "brief.pdf")
      const written = await run(
        docs().pdf.write({
          path: "brief.pdf",
          title: "Engine brief",
          pages: [{ lines: ["First line of the brief", "Second line of the brief"] }, { lines: ["Page two"] }],
        }),
      )
      expect(written.bytes).toBe((await fs.stat(file)).size)
      expect(await magic(file, 5)).toBe("%PDF-")

      const read = await run(docs().pdf.read({ path: file }))
      expect(read.pageCount).toBe(2)
      expect(read.title).toBe("Engine brief")
      expect(read.pages).toHaveLength(2)
      expect(read.pages[0]!.textComplete).toBe(true)
      expect(read.pages[0]!.text).toContain("First line of the brief")
      expect(read.pages[0]!.text).toContain("Second line of the brief")
      expect(read.pages[1]!.text).toContain("Page two")
      expect(read.pages[1]!.reason).toBeUndefined()
    })

    test("lines overflow onto new pages instead of being dropped", async () => {
      const file = path.join(directory, "long.pdf")
      const lines = Array.from({ length: 140 }, (_, index) => `line ${index}`)
      await run(docs().pdf.write({ path: file, pages: [{ lines }] }))
      const read = await run(docs().pdf.read({ path: file }))
      expect(read.pageCount).toBeGreaterThan(1)
      const all = read.pages.map((page) => page.text).join("\n")
      expect(all).toContain("line 0")
      expect(all).toContain("line 139")
    })

    test("a page that draws no text is reported incomplete with a reason, not as empty text", async () => {
      const file = path.join(directory, "blank.pdf")
      await run(docs().pdf.write({ path: file, pages: [{ lines: [] }] }))
      const read = await run(docs().pdf.read({ path: file }))
      expect(read.pages[0]!.textComplete).toBe(false)
      expect(read.pages[0]!.reason).toBeTruthy()
      expect(read.pages[0]!.text).toBe("")
    })

    test("a non-PDF file is rejected rather than read as zero pages", async () => {
      const file = path.join(directory, "not-really.pdf")
      await fs.writeFile(file, "definitely not a pdf")
      const error = await errorOf(docs().pdf.read({ path: file }))
      expect(error).toBeInstanceOf(DocumentFailureError)
      expect(error.message).toStartWith("`pdf.read` failed:")
    })

    test("a nonsense font size is refused before any file is produced", async () => {
      const error = await errorOf(docs().pdf.write({ path: "bad.pdf", fontSize: 0, pages: [{ lines: ["x"] }] }))
      expect(error.message).toContain("is not a size")
      expect(await fs.exists(path.join(directory, "bad.pdf"))).toBe(false)
    })
  })

  describe("the PDF content-stream text extractor", () => {
    test("reads literal, hex and array-shown strings", () => {
      const stream = "BT /F1 12 Tf (hello ) Tj <776F726C64> Tj T* [(next) ( line)] TJ ET"
      const { text, skipped } = extractPdfText(stream, () => true)
      expect(skipped).toStrictEqual([])
      expect(text).toBe("hello world\nnext line")
    })

    test("honours escapes and balanced parentheses inside a literal string", () => {
      const stream = String.raw`BT /F1 12 Tf (a\(b\)c \\ d\101e) Tj ET`
      expect(extractPdfText(stream, () => true).text).toBe("a(b)c \\ dAe")
    })

    test("a run in a font it cannot decode is SKIPPED and named, never emitted as glyph codes", () => {
      // /F2 stands for a composite Type0 font: its string bytes are glyph identifiers.
      const stream = "BT /F1 12 Tf (readable) Tj /F2 12 Tf <00480049> Tj ET"
      const { text, skipped } = extractPdfText(stream, (font) => font !== "F2")
      expect(text).toBe("readable")
      expect(text).not.toContain("\u0000")
      expect(skipped).toStrictEqual(["F2"])
    })
  })

  describe("the permission guard", () => {
    test("a refused write produces no file and reports the refusal", async () => {
      const blocked = documents({
        directory,
        guard: (filepath) =>
          Effect.fail(
            new DocumentFailureError({ object: "document", operation: "write", reason: `denied for ${filepath}` }),
          ),
      })
      const error = await errorOf(blocked.docx.write({ path: "denied.docx", paragraphs: [{ text: "x" }] }))
      expect(error.message).toContain("denied for")
      expect(await fs.exists(path.join(directory, "denied.docx"))).toBe(false)
    })

    test("the guard sees the resolved absolute path, and a read is not gated by it", async () => {
      const seen: string[] = []
      const watched = documents({
        directory,
        guard: (filepath) => Effect.sync(() => void seen.push(filepath)),
      })
      await run(watched.docx.write({ path: "guarded.docx", paragraphs: [{ text: "ok" }] }))
      expect(seen).toStrictEqual([path.join(directory, "guarded.docx")])
      await run(watched.docx.read({ path: "guarded.docx" }))
      expect(seen).toHaveLength(1)
    })
  })

  describe("a real Code Mode program", () => {
    test("writes a real file through the `docx` global and reads it back through `xlsx`", async () => {
      const programDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "redrob-k3-program-"))
      try {
        const output = await runProgram(
          `
          const written = await docx.write({
            path: "from-a-program.docx",
            title: "Written by a program",
            paragraphs: [{ text: "This paragraph came out of code mode." }],
          })
          const back = await docx.read({ path: "from-a-program.docx" })
          await xlsx.write({ path: "sizes.xlsx", sheets: [{ name: "Sizes", rows: [["bytes", written.bytes]] }] })
          const sheet = await xlsx.read({ path: "sizes.xlsx" })
          return { written, paragraphs: back.paragraphs, recorded: sheet.sheets[0].rows[0][1] }
          `,
          programDirectory,
        )
        const result = JSON.parse(output.output) as {
          written: { path: string; bytes: number }
          paragraphs: string[]
          recorded: number
        }
        expect(result.written.path).toBe(path.join(programDirectory, "from-a-program.docx"))
        expect(result.paragraphs).toContain("This paragraph came out of code mode.")
        // The file the PROGRAM claims it wrote is checked on disk here, from outside the sandbox.
        const stat = await fs.stat(result.written.path)
        expect(stat.size).toBe(result.written.bytes)
        expect(result.recorded).toBe(result.written.bytes)
        expect(await magic(result.written.path, 2)).toBe("PK")
      } finally {
        await fs.rm(programDirectory, { recursive: true, force: true })
      }
    })

    test("a failing document call surfaces its reason to the program, not a fake success", async () => {
      const programDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "redrob-k3-program-"))
      try {
        const output = await runProgram(
          `
          try {
            await pdf.read({ path: "nowhere.pdf" })
            return "NO ERROR"
          } catch (error) {
            return String(error.message ?? error)
          }
          `,
          programDirectory,
        )
        expect(output.output).toContain("`pdf.read` failed")
        expect(output.output).toContain("no file at")
      } finally {
        await fs.rm(programDirectory, { recursive: true, force: true })
      }
    })
  })

  describe("the refusing implementation", () => {
    test("every method of every object fails naming the object and the reason", async () => {
      const refusing = unavailableDocuments("no document toolchain in this preview")
      const calls: Array<[string, Effect.Effect<unknown, DocumentError>]> = [
        ["docx", refusing.docx.read({ path: "a.docx" })],
        ["docx", refusing.docx.write({ path: "a.docx", paragraphs: [] })],
        ["xlsx", refusing.xlsx.read({ path: "a.xlsx" })],
        ["xlsx", refusing.xlsx.write({ path: "a.xlsx", sheets: [] })],
        ["pptx", refusing.pptx.read({ path: "a.pptx" })],
        ["pptx", refusing.pptx.write({ path: "a.pptx", slides: [] })],
        ["pdf", refusing.pdf.read({ path: "a.pdf" })],
        ["pdf", refusing.pdf.write({ path: "a.pdf", pages: [] })],
      ]
      for (const [object, call] of calls) {
        const error = await errorOf(call)
        expect(error).toBeInstanceOf(DomainUnavailableError)
        expect(error.message).toBe(
          `The \`${object}\` domain object is not available in this session: no document toolchain in this preview`,
        )
      }
    })
  })
})
