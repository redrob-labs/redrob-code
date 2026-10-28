import { describe, expect, test } from "bun:test"
import { parse } from "../../src/util/answeroptions"

describe("util.answeroptions", () => {
  test("reads a bracketed options line and strips it from the body", () => {
    expect(parse("Pick one.\n\n[OPTIONS: Merge it now | Show me the diff]\n")).toEqual({
      body: "Pick one.",
      options: ["Merge it now", "Show me the diff"],
    })
  })

  test("reads an options line without brackets", () => {
    expect(parse("Pick one.\nOPTIONS: a | b | c")).toEqual({ body: "Pick one.", options: ["a", "b", "c"] })
  })

  test("leaves a single option as plain text", () => {
    const text = "Pick one.\n[OPTIONS: only one]"
    expect(parse(text)).toEqual({ body: text, options: [] })
  })

  test("cuts more than five options to five", () => {
    expect(parse("x\n[OPTIONS: 1 | 2 | 3 | 4 | 5 | 6 | 7]").options).toEqual(["1", "2", "3", "4", "5"])
  })

  test("ignores an options line inside an unclosed code fence", () => {
    const text = "Example:\n```\n[OPTIONS: a | b]"
    expect(parse(text)).toEqual({ body: text, options: [] })
  })

  test("ignores an options line that is not the last line", () => {
    const text = "[OPTIONS: a | b]\nMore text after."
    expect(parse(text)).toEqual({ body: text, options: [] })
  })
})
