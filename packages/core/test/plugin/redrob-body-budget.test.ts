import { afterEach, describe, expect, test } from "bun:test"
import {
  budgetConsoleBody,
  consoleCharLimit,
  forgetConsoleCharLimits,
  parseConsoleCharLimit,
  sendConsoleBudgeted,
} from "@redrob-code/core/plugin/provider/redrob-body-budget"

const CONSOLE_ERROR =
  '{"error":{"message":"The conversation is longer than this model accepts (81,920 characters across all messages, counting an inline image or audio clip at the size of its payload). Drop older turns, shorten the tool results you are sending back, or send a smaller image.","type":"invalid_request_error","param":"messages","code":null}}'

type Message = Record<string, unknown>
const image = (chars: number) => ({
  type: "image_url",
  image_url: { url: `data:image/png;base64,${"A".repeat(chars)}` },
})
const readCall = (path: string) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    { id: "call_1", type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: path }) } },
  ],
})
const body = (messages: Message[]) => ({
  model: "redrob-free",
  messages: [{ role: "system", content: "sys" }, ...messages],
})
const contentOf = (result: { messages: unknown[] }, index: number) => (result.messages[index] as Message).content
const chars = (result: { messages: unknown[] }) => JSON.stringify(result.messages).length

afterEach(() => forgetConsoleCharLimits())

describe("console character limit", () => {
  test("parses the model limit from the console error", () => {
    expect(parseConsoleCharLimit(CONSOLE_ERROR)).toBe(81_920)
    expect(parseConsoleCharLimit("The request body is larger than this endpoint accepts (2mb)")).toBeUndefined()
  })

  test("leaves a body under both limits untouched", () => {
    const input = body([{ role: "user", content: "hi" }])
    expect(budgetConsoleBody(input, { modelChars: 81_920 })).toBe(input)
  })

  test("prunes older long text first and keeps the latest message", () => {
    const input = body([
      { role: "user", content: "x".repeat(60_000) },
      { role: "assistant", content: "ok" },
      { role: "user", content: "y".repeat(20_000) },
    ])
    const result = budgetConsoleBody(input, { modelChars: 50_000 })
    expect((contentOf(result, 1) as string).length).toBeLessThan(5_000)
    expect(contentOf(result, 3)).toBe("y".repeat(20_000))
  })

  test("counts an inline image at its payload size and drops older images first", () => {
    const input = body([
      { role: "user", content: [{ type: "text", text: "old" }, image(25_000)] },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "text", text: "new" }, image(20_000)] },
    ])
    const result = budgetConsoleBody(input, { modelChars: 50_000 })
    expect(contentOf(result, 1)).toEqual([
      { type: "text", text: "old" },
      { type: "text", text: "[image omitted: request size limit]" },
    ])
    expect((contentOf(result, 3) as Message[])[1]).toEqual(image(20_000))
  })

  test("replaces a latest tool image that alone exceeds the limit with a note naming the file", () => {
    const input = body([
      { role: "user", content: "show me the screenshot" },
      readCall("/home/me/shots/screen.png"),
      { role: "tool", tool_call_id: "call_1", content: "Image read successfully" },
      { role: "user", content: [{ type: "text", text: "Attached media from tool result:" }, image(400_000)] },
    ])
    const result = budgetConsoleBody(input, { modelChars: 81_920 })
    const note = (contentOf(result, 4) as Message[])[1]!
    expect(note.type).toBe("text")
    expect(note.text).toBe(
      "[image not sent: screen.png is 293 KB and this model accepts about 81,920 characters; describe what you can from the file name/metadata, or ask the user to pick a model that reads images]",
    )
    expect(chars(result)).toBeLessThan(81_920)
  })

  test("sends the note up front for an image over 60% of a known limit", () => {
    const input = body([
      { role: "user", content: "look" },
      readCall("a.png"),
      { role: "tool", tool_call_id: "call_1", content: "Image read successfully" },
      { role: "user", content: [{ type: "text", text: "Attached media from tool result:" }, image(60_000)] },
    ])
    const result = budgetConsoleBody(input, { modelChars: 81_920 })
    expect(((contentOf(result, 4) as Message[])[1]!.text as string).startsWith("[image not sent: a.png")).toBe(true)
  })

  test("re-sends once with the learned limit and budgets later requests to it", async () => {
    const input = JSON.stringify(
      body([
        { role: "user", content: "x".repeat(100_000) },
        { role: "assistant", content: "ok" },
        { role: "user", content: "again" },
      ]),
    )
    const sent: string[] = []
    const send = async (text: string) => {
      sent.push(text)
      return sent.length === 1 ? new Response(CONSOLE_ERROR, { status: 400 }) : new Response("{}", { status: 200 })
    }
    const response = await sendConsoleBudgeted(input, send)
    expect(response.status).toBe(200)
    expect(sent).toHaveLength(2)
    expect(sent[0]).toBe(input)
    expect(sent[1]!.length).toBeLessThan(81_920)
    expect(consoleCharLimit("redrob-free")).toBe(81_920)

    // Next request (compaction included) is budgeted before sending.
    const later: string[] = []
    await sendConsoleBudgeted(input, async (text) => (later.push(text), new Response("{}")))
    expect(later).toHaveLength(1)
    expect(later[0]!.length).toBeLessThan(81_920)
  })

  test("hands other 400s back without a retry", async () => {
    const sent: string[] = []
    const response = await sendConsoleBudgeted(
      JSON.stringify(body([{ role: "user", content: "hi" }])),
      async (text) => {
        sent.push(text)
        return new Response('{"error":{"message":"bad"}}', { status: 400 })
      },
    )
    expect(response.status).toBe(400)
    expect(sent).toHaveLength(1)
  })
})
