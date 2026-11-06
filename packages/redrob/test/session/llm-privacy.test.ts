/**
 * PII masking on the v1 session path (desktop chat turns go through `streamText`).
 *
 * A mock model records the prompt it was sent and answers with a placeholder split across two
 * deltas, plus a tool call whose input carries a placeholder. The model must see `[EMAIL_1]`; the
 * streamed text and the tool must get the real address. With the switch off nothing is rewritten.
 */
import { describe, expect, test } from "bun:test"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { simulateReadableStream, streamText, tool, wrapLanguageModel, type ModelMessage } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import z from "zod"
import { LLMPrivacy } from "../../src/session/llm/privacy"

const EMAIL = "jiwon.kim@example.com"
const answer = "Your address is [EMAIL_1], spelled out."

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

const model = () => {
  const prompts: LanguageModelV3CallOptions["prompt"][] = []
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: answer.slice(0, 22) },
    { type: "text-delta", id: "t", delta: answer.slice(22) },
    { type: "text-end", id: "t" },
    { type: "tool-call", toolCallId: "c1", toolName: "send", input: JSON.stringify({ to: "[EMAIL_1]" }) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
  ]
  const mock = new MockLanguageModelV3({
    doStream: async (options) => {
      prompts.push(options.prompt)
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
  return { mock, prompts }
}

const messages: ModelMessage[] = [
  { role: "system", content: `The user's contact is ${EMAIL}.` },
  { role: "user", content: [{ type: "text", text: `Spell my email ${EMAIL} letter by letter` }] },
]

const run = async (mode: "off" | "regex") => {
  const { mock, prompts } = model()
  const vault = new LLMPrivacy.Vaults().forTurn({ mode }, "ses_test")
  const sent: unknown[] = []
  const result = streamText({
    model: wrapLanguageModel({ model: mock, middleware: vault ? [LLMPrivacy.middleware(vault)] : [] }),
    messages,
    tools: {
      send: tool({
        inputSchema: z.object({ to: z.string() }),
        execute: async (input) => {
          sent.push(input)
          return "ok"
        },
      }),
    },
  })
  let text = ""
  const calls: unknown[] = []
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") text += part.text
    if (part.type === "tool-call") calls.push(part.input)
  }
  return { vault, prompts, text, calls, sent }
}

describe("session.llm privacy masking", () => {
  test("regex: the model sees placeholders, the stream and the tool get real values", async () => {
    const { vault, prompts, text, calls, sent } = await run("regex")
    expect(vault).toBeDefined()
    const outgoing = JSON.stringify(prompts)
    expect(outgoing).not.toContain(EMAIL)
    expect(outgoing).toContain("[EMAIL_1]")
    expect(text).toBe(`Your address is ${EMAIL}, spelled out.`)
    expect(calls).toEqual([{ to: EMAIL }])
    expect(sent).toEqual([{ to: EMAIL }])
  })

  test("off: the prompt goes out as written", async () => {
    const { vault, prompts, text } = await run("off")
    expect(vault).toBeUndefined()
    expect(JSON.stringify(prompts)).toContain(EMAIL)
    expect(text).toBe(answer)
  })

  test("a session keeps one vault, so a value keeps its placeholder across turns", () => {
    const vaults = new LLMPrivacy.Vaults()
    const first = vaults.forTurn({ mode: "regex" }, "ses_a")!
    expect(first.maskText(EMAIL)).toBe("[EMAIL_1]")
    expect(vaults.forTurn({ mode: "model", model: "local/x" }, "ses_a")).toBe(first)
    expect(vaults.forTurn({ mode: "regex" }, "ses_b")).not.toBe(first)
  })

  test("earlier assistant tool calls and tool results are masked when replayed", () => {
    const vault = new LLMPrivacy.Vaults().forTurn({ mode: "regex" }, "ses_c")!
    const masked = LLMPrivacy.maskPrompt(vault, [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "send", input: { to: EMAIL } }] },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", toolName: "send", output: { type: "json", value: { to: EMAIL } } },
        ],
      },
    ])
    expect(JSON.stringify(masked)).not.toContain(EMAIL)
    expect(JSON.stringify(masked)).toContain("[EMAIL_1]")
  })

  test("onMasked reports kind -> count of what the provider was sent, never the values", async () => {
    const vault = new LLMPrivacy.Vaults().forTurn({ mode: "regex" }, "ses_counts")!
    vault.add({ value: "김지원", kind: "PERSON" })
    vault.add({ value: "Unsent Corp", kind: "ORG" })
    const { mock } = model()
    const reports: LLMPrivacy.Counts[] = []
    const result = streamText({
      model: wrapLanguageModel({ model: mock, middleware: [LLMPrivacy.middleware(vault, (c) => reports.push(c))] }),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: `김지원 900101-1234567, 010-1234-5678, ${EMAIL}, again ${EMAIL}` }],
        },
      ],
    })
    for await (const _ of result.fullStream) void _
    expect(reports[0]).toEqual({ PERSON: 1, RRN: 1, PHONE: 1, EMAIL: 1 })
    expect(JSON.stringify(reports)).not.toContain("김지원")
    expect(LLMPrivacy.mergeCounts({ PERSON: 2 }, { PERSON: 1, EMAIL: 1 })).toEqual({ PERSON: 2, EMAIL: 1 })
  })

  test("readableTexts skips the system prompt", () => {
    expect(LLMPrivacy.readableTexts(messages)).toEqual([`Spell my email ${EMAIL} letter by letter`])
  })
})
