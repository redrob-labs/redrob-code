import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  budgetConsoleBody,
  CHAR_LIMIT_TTL_MS,
  consoleCharLimit,
  consoleImageNote,
  consoleVisionModel,
  forgetConsoleCharLimits,
  parseConsoleCharLimit,
  rememberConsoleCharLimit,
  rememberConsoleModels,
  routeConsoleBody,
  sendConsoleBudgeted,
  setConsoleBudgetClock,
  setConsoleVisionSetting,
  type ConsoleModelSwitch,
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
const body = (messages: Message[], model = "redrob-free") => ({
  model,
  messages: [{ role: "system", content: "sys" }, ...messages],
})
const imageTurn = (chars: number, name = "george-v3.png") => [
  { role: "user", content: "what is in it?" },
  readCall(`/home/me/${name}`),
  { role: "tool", tool_call_id: "call_1", content: "Image read successfully" },
  { role: "user", content: [{ type: "text", text: "Attached media from tool result:" }, image(chars)] },
]
const contentOf = (result: { messages: unknown[] }, index: number) => (result.messages[index] as Message).content
const chars = (result: { messages: unknown[] }) => JSON.stringify(result.messages).length
const hasImage = (text: string) => text.includes('"image_url"')

// The desk.visionModel setting is read from the settings file, so the tests pin it to unset.
beforeEach(() => setConsoleVisionSetting(() => undefined))
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
      { type: "text", text: consoleImageNote("the image") },
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
    expect(note.text).toBe(consoleImageNote("screen.png"))
    expect(chars(result)).toBeLessThan(81_920)
  })

  test("the image note forbids OCR and tells the model the user already sees the image", () => {
    const note = consoleImageNote("george-v3.png")
    expect(note).toContain("george-v3.png")
    expect(note).toContain("Do not try to read it with OCR or any other tool")
    expect(note).toContain("already shown to them in the chat")
    expect(note).toContain("switching to a model that can see images")
    expect(note).not.toContain("describe what you can from the file name")
  })

  test("sends the note up front for an image over 60% of a known limit", () => {
    const result = budgetConsoleBody(body(imageTurn(60_000, "a.png")), { modelChars: 81_920 })
    expect((contentOf(result, 4) as Message[])[1]!.text).toBe(consoleImageNote("a.png"))
  })

  test("a remembered limit pre-drops images only for that same model id", () => {
    rememberConsoleCharLimit("redrob-free", 81_920)
    const same = budgetConsoleBody(body(imageTurn(60_000)))
    expect((contentOf(same, 4) as Message[])[1]!.type).toBe("text")
    const other = body(imageTurn(60_000), "claude-sonnet-5")
    expect(budgetConsoleBody(other)).toBe(other)
  })

  test("a learned limit is forgotten after 10 minutes", () => {
    let now = 1_000_000
    setConsoleBudgetClock(() => now)
    rememberConsoleCharLimit("redrob-free", 81_920)
    now += CHAR_LIMIT_TTL_MS - 1
    expect(consoleCharLimit("redrob-free")).toBe(81_920)
    now += 2
    expect(consoleCharLimit("redrob-free")).toBeUndefined()
    const input = body(imageTurn(60_000))
    expect(budgetConsoleBody(input)).toBe(input)
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

  test("a router id (auto) is not remembered: only that request is re-sent smaller", async () => {
    const input = JSON.stringify(
      body(
        [
          { role: "user", content: "x".repeat(100_000) },
          { role: "assistant", content: "ok" },
          { role: "user", content: "again" },
        ],
        "auto",
      ),
    )
    expect(rememberConsoleCharLimit("auto", 81_920)).toBe(false)
    expect(rememberConsoleCharLimit("redrob-auto", 81_920)).toBe(false)
    const sent: string[] = []
    await sendConsoleBudgeted(input, async (text) => {
      sent.push(text)
      return sent.length === 1 ? new Response(CONSOLE_ERROR, { status: 400 }) : new Response("{}")
    })
    expect(sent).toHaveLength(2)
    expect(sent[1]!.length).toBeLessThan(81_920)
    expect(consoleCharLimit("auto")).toBeUndefined()

    // The next auto request goes out whole: it may route to a model with a larger window.
    const later: string[] = []
    await sendConsoleBudgeted(input, async (text) => (later.push(text), new Response("{}")))
    expect(later[0]).toBe(input)
  })

  test("a router id listed as routed is not remembered either", () => {
    rememberConsoleModels([{ id: "redrob-router", routed: true }])
    expect(rememberConsoleCharLimit("redrob-router", 81_920)).toBe(false)
    expect(consoleCharLimit("redrob-router")).toBeUndefined()
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

describe("vision model switch", () => {
  test("picks the desk.visionModel setting, then the first listed image model, then a known id", () => {
    rememberConsoleModels([{ id: "redrob-free", image: false }, { id: "auto" }, { id: "gpt-5.6-terra", image: true }])
    expect(consoleVisionModel("redrob-free")).toBe("gpt-5.6-terra")
    setConsoleVisionSetting(() => "claude-opus-5")
    expect(consoleVisionModel("redrob-free")).toBe("claude-opus-5")
    setConsoleVisionSetting(() => undefined)
    rememberConsoleModels([{ id: "redrob-free" }, { id: "claude-sonnet-5" }])
    expect(consoleVisionModel("redrob-free")).toBe("claude-sonnet-5")
    rememberConsoleModels([{ id: "redrob-free" }])
    expect(consoleVisionModel("redrob-free")).toBeUndefined()
  })

  test("a model without image input sends that one step to the vision model", () => {
    rememberConsoleModels([
      { id: "redrob-free", image: false },
      { id: "gpt-5.6-terra", image: true },
    ])
    const input = body(imageTurn(1_000))
    const route = routeConsoleBody(input)
    expect(route.switched).toEqual({ from: "redrob-free", to: "gpt-5.6-terra", reason: "no-image-input" })
    expect(route.body.model).toBe("gpt-5.6-terra")
    expect((contentOf(route.body, 4) as Message[])[1]).toEqual(image(1_000))
    // A step without images stays on the selected model.
    const next = routeConsoleBody(body([{ role: "user", content: "thanks" }]))
    expect(next.switched).toBeUndefined()
    expect(next.body.model).toBe("redrob-free")
  })

  test("an image over the learned limit goes to the vision model, budgeted to that model's own limit", () => {
    rememberConsoleModels([{ id: "redrob-free" }, { id: "gpt-5.6-terra", image: true }])
    rememberConsoleCharLimit("redrob-free", 81_920)
    const route = routeConsoleBody(body(imageTurn(60_000)))
    expect(route.switched?.reason).toBe("limit")
    expect(route.body.model).toBe("gpt-5.6-terra")
    expect((contentOf(route.body, 4) as Message[])[1]).toEqual(image(60_000))

    // The vision model's own learned limit applies to it, not redrob-free's.
    rememberConsoleCharLimit("gpt-5.6-terra", 50_000)
    const tight = routeConsoleBody(body(imageTurn(60_000)))
    expect(tight.switched).toBeUndefined()
    expect((contentOf(tight.body, 4) as Message[])[1]!.text).toBe(consoleImageNote("george-v3.png"))
  })

  test("without a vision model the image becomes the note", () => {
    rememberConsoleModels([{ id: "redrob-free", image: false }])
    const route = routeConsoleBody(body(imageTurn(1_000)))
    expect(route.switched).toBeUndefined()
    expect((contentOf(route.body, 4) as Message[])[1]!.text).toBe(consoleImageNote("george-v3.png"))
  })

  test("auto: the 400 retry tries the vision model before the note", async () => {
    rememberConsoleModels([{ id: "auto" }, { id: "gpt-5.6-terra", image: true }])
    const input = JSON.stringify(body(imageTurn(60_000), "auto"))
    const sent: string[] = []
    const switches: ConsoleModelSwitch[] = []
    await sendConsoleBudgeted(
      input,
      async (text) => {
        sent.push(text)
        return sent.length === 1 ? new Response(CONSOLE_ERROR, { status: 400 }) : new Response("{}")
      },
      (change) => switches.push(change),
    )
    expect(sent).toHaveLength(2)
    expect(sent[0]).toBe(input)
    expect(JSON.parse(sent[1]!).model).toBe("gpt-5.6-terra")
    expect(hasImage(sent[1]!)).toBe(true)
    expect(switches).toEqual([{ from: "auto", to: "gpt-5.6-terra", reason: "limit" }])
    expect(consoleCharLimit("auto")).toBeUndefined()
  })
})
