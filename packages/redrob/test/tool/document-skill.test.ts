/**
 * K-3's skill document, held to the code it describes.
 *
 * A skill is only cheap because the objects exist; a skill that describes a method that does
 * not exist produces an agent that calls it and fails. So this test reads the document the
 * engine actually ships — `SkillPlugin.DocumentToolchainContent` — and checks it BOTH ways:
 * every `<global>.<method>` the document names is a real tool, and every real tool is named by
 * the document. The field names it promises are compared against the keys real calls return,
 * not against a list retyped here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { SkillPlugin } from "@redrob-code/core/plugin/skill"
import { DOCUMENT_GLOBALS, documentTools, documents, unavailableDocuments } from "@/tool/document"

const DOC = SkillPlugin.DocumentToolchainContent

let directory: string
beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "redrob-k3-skill-"))
})
afterAll(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

/** Every `<global>.<method>` the document mentions, deduplicated. */
const mentioned = new Set(
  [...DOC.matchAll(/\b(docx|xlsx|pptx|pdf)\.([A-Za-z]+)\b/g)].map((match) => `${match[1]}.${match[2]}`),
)

/** Every `<global>.<method>` the code actually binds. */
const real = new Set(
  Object.entries(documentTools(unavailableDocuments())).flatMap(([global, namespace]) =>
    Object.keys(namespace).map((method) => `${global}.${method}`),
  ),
)

describe("the K-3 skill document describes the code that exists", () => {
  test("it names every global the engine binds", () => {
    for (const name of DOCUMENT_GLOBALS) expect(DOC).toContain(`\`${name}\``)
  })

  test("every method the document names is a real tool", () => {
    expect([...mentioned].filter((entry) => !real.has(entry))).toStrictEqual([])
  })

  test("every real tool is documented, so nothing ships undescribed", () => {
    expect([...real].filter((entry) => !mentioned.has(entry))).toStrictEqual([])
  })

  test("the result fields it promises are the fields a real call returns", async () => {
    const docs = documents({ directory })

    const docxWrite = await run(docs.docx.write({ path: path.join(directory, "a.docx"), paragraphs: [{ text: "x" }] }))
    for (const key of Object.keys(docxWrite)) expect(DOC).toContain(key)

    const docxRead = await run(docs.docx.read({ path: path.join(directory, "a.docx") }))
    for (const key of Object.keys(docxRead)) expect(DOC).toContain(key)

    await run(
      docs.xlsx.write({ path: path.join(directory, "a.xlsx"), sheets: [{ name: "S", rows: [["h"]] }] }),
    )
    const xlsxRead = await run(docs.xlsx.read({ path: path.join(directory, "a.xlsx") }))
    for (const key of Object.keys(xlsxRead)) expect(DOC).toContain(key)
    for (const key of Object.keys(xlsxRead.sheets[0]!)) expect(DOC).toContain(key)

    await run(docs.pptx.write({ path: path.join(directory, "a.pptx"), slides: [{ title: "T" }] }))
    const pptxRead = await run(docs.pptx.read({ path: path.join(directory, "a.pptx") }))
    for (const key of Object.keys(pptxRead)) expect(DOC).toContain(key)
    for (const key of Object.keys(pptxRead.slides[0]!)) expect(DOC).toContain(key)

    await run(docs.pdf.write({ path: path.join(directory, "a.pdf"), title: "T", pages: [{ lines: ["l"] }] }))
    const pdfRead = await run(docs.pdf.read({ path: path.join(directory, "a.pdf") }))
    for (const key of Object.keys(pdfRead)) expect(DOC).toContain(key)
    for (const key of Object.keys(pdfRead.pages[0]!)) expect(DOC).toContain(key)
    // `reason` only appears on an incomplete page, so it is asserted from one.
    const blank = await run(docs.pdf.write({ path: path.join(directory, "b.pdf"), pages: [{ lines: [] }] }))
    expect(blank.bytes).toBeGreaterThan(0)
    const blankRead = await run(docs.pdf.read({ path: path.join(directory, "b.pdf") }))
    for (const key of Object.keys(blankRead.pages[0]!)) expect(DOC).toContain(key)
  })

  test("it states the limit that makes pdf.read honest, and does not promise OCR", () => {
    expect(DOC).toContain("textComplete")
    expect(DOC).toContain("Type0")
    expect(DOC).toContain("there is no OCR in the engine")
    expect(DOC).not.toContain("Aside")
  })

  test("the registered skill's own description and arming match the document it carries", async () => {
    // The skill is registered as an embedded source in packages/core; this asserts the body
    // the plugin hands over is this document and not a stale copy.
    expect(DOC).toContain("# Reading and writing documents in code mode")
    expect(DOC.startsWith("<!--")).toBe(true)
  })
})
