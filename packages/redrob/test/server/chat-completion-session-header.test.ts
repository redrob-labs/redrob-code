import { describe, expect, test } from "bun:test"
import { sessionHeader } from "@redrob-code/server/handlers/chat-completion"

/**
 * `x-redrob-session` on /v1/chat/completions: forwarded so the console can join a labeled session to
 * what its requests cost, but only to the Redrob provider and only when it is an id, never text.
 */
describe("x-redrob-session on chat completions", () => {
  test("is forwarded to the Redrob provider in the console's id format", () => {
    expect(sessionHeader("redrob/auto", { "x-redrob-session": "of_0123abcd" })).toEqual({
      "x-redrob-session": "of_0123abcd",
    })
    expect(sessionHeader("auto", { "x-redrob-session": "cw_1:2.3-4" })).toEqual({ "x-redrob-session": "cw_1:2.3-4" })
  })

  test("is dropped when it is not an id, and when absent", () => {
    expect(sessionHeader("redrob/auto", { "x-redrob-session": "Refund 4,500,000 KRW to Kim" })).toBeUndefined()
    expect(sessionHeader("redrob/auto", { "x-redrob-session": "x".repeat(129) })).toBeUndefined()
    expect(sessionHeader("redrob/auto", {})).toBeUndefined()
  })

  test("never goes to another vendor", () => {
    expect(sessionHeader("openai/gpt-5", { "x-redrob-session": "of_0123abcd" })).toBeUndefined()
    expect(sessionHeader("ollama/llama3", { "x-redrob-session": "of_0123abcd" })).toBeUndefined()
  })
})
