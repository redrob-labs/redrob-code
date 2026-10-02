import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, Tool } from "../src/index.js"

const text = Tool.make({
  description: "Visible text of the page",
  input: Schema.Struct({}),
  output: Schema.String,
  run: () => Effect.succeed("hello from the page"),
})

const click = Tool.make({
  description: "Click the first node matching a selector",
  input: Schema.Struct({ selector: Schema.String }),
  output: Schema.Boolean,
  run: (input) => Effect.succeed(input.selector === "button"),
})

const page = { text, click }

const run = (code: string, globals: ReadonlyArray<string> = ["page"]) =>
  Effect.runPromise(CodeMode.make({ tools: { page }, globals }).execute(code))

describe("CodeMode host globals", () => {
  test("a bare global resolves to its tool namespace", async () => {
    const result = await run("return await page.text({})")
    expect(result).toMatchObject({ ok: true, value: "hello from the page" })
  })

  test("the bare form and the tools form are the same call", async () => {
    const result = await run(
      'return [await page.click({ selector: "button" }), await tools.page.click({ selector: "a" })]',
    )
    expect(result).toMatchObject({ ok: true, value: [true, false] })
    expect(result.toolCalls.map((call) => call.name)).toStrictEqual(["page.click", "page.click"])
  })

  test("a global is enumerable like any namespace", async () => {
    const result = await run("return Object.keys(page).toSorted()")
    expect(result).toMatchObject({ ok: true, value: ["click", "text"] })
  })

  test("a top-level declaration still shadows a global, as in a JS module", async () => {
    const result = await run('const page = "shadowed"; return page')
    expect(result).toMatchObject({ ok: true, value: "shadowed" })
  })

  test("an unlisted namespace is not bound as a global", async () => {
    const result = await Effect.runPromise(CodeMode.make({ tools: { page } }).execute("return await page.text({})"))
    expect(result.ok).toBe(false)
    expect(result.ok ? "" : result.error.message).toContain("page")
  })

  test("the instructions name the globals and the equivalence", async () => {
    const instructions = CodeMode.make({ tools: { page }, globals: ["page"] }).instructions()
    expect(instructions).toContain("## Domain globals")
    expect(instructions).toContain("`page`")
    expect(instructions).toContain("`tools.<global>.<tool>(input)` are the same call")
  })

  test("no globals section is rendered when no globals are declared", () => {
    expect(CodeMode.make({ tools: { page } }).instructions()).not.toContain("## Domain globals")
  })

  describe("refuses a global a host cannot honestly bind", () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<string>, string]> = [
      ["a name that is not in the tool tree", ["screen"], "not a top-level namespace"],
      ["a builtin global", ["Math"], "collides with a builtin global"],
      ["the tools binding itself", ["tools"], "collides with a builtin global"],
      ["a duplicate", ["page", "page"], "listed more than once"],
      ["a non-identifier", ["page-object"], "not a plain identifier"],
    ]
    for (const [name, globals, message] of cases) {
      test(name, () => {
        expect(() => CodeMode.make({ tools: { page }, globals })).toThrow(message)
      })
    }

    test("a tool rather than a namespace", () => {
      expect(() => CodeMode.make({ tools: { text }, globals: ["text"] })).toThrow("not a tool itself")
    })
  })
})
