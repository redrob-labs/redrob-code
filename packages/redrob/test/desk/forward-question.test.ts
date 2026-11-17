import { describe, expect, test } from "bun:test"
import { match } from "../../src/desk/forward"

describe("desk question routes", () => {
  test("a device lists, answers and dismisses the agent's questions", () => {
    expect(match({ method: "GET", path: "/api/session/ses_a/question" })).toMatchObject({ sessionID: "ses_a" })
    expect(
      match({ method: "POST", path: "/api/session/ses_a/question/que_1/reply", body: { answers: [["예"], ["A", "B"]] } }),
    ).toBeDefined()
    expect(match({ method: "POST", path: "/api/session/ses_a/question/que_1/reject" })).toBeDefined()
  })

  test("bad answers and paths are refused", () => {
    expect(match({ method: "POST", path: "/api/session/ses_a/question/que_1/reply", body: { answers: "예" } })).toBeUndefined()
    expect(match({ method: "POST", path: "/api/session/ses_a/question/que_1/reply", body: { answers: [[1]] } })).toBeUndefined()
    expect(match({ method: "POST", path: "/api/session/ses_a/question/../reply", body: { answers: [] } })).toBeUndefined()
    expect(match({ method: "GET", path: "/api/question/request" })).toBeUndefined()
  })
})
