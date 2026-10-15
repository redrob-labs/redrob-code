/**
 * PII masking on `POST /v1/chat/completions`.
 *
 * The runner test proves the switch for agent sessions; this one proves the same masker guards the
 * OpenAI-compatible route, which does not go through the runner. A stub provider records what it
 * was sent and answers with a placeholder: the provider must see `[EMAIL_1]`, the caller must read
 * the real address back, in both the streamed and the assembled form.
 */
import { describe, expect, test } from "bun:test"
import { LLMClient, LLMEvent, LLM, Message, Model, type LLMClientShape, type LLMRequest } from "@redrob-code/llm"
import * as OpenAIChat from "@redrob-code/llm/protocols/openai-chat"
import { Privacy } from "@redrob-code/core/privacy/service"
import { maskedGenerate, maskedRequest, maskedStream } from "@redrob-code/server/handlers/chat-completion"
import { Effect, Layer, Stream } from "effect"

const sent: LLMRequest[] = []
const answer = "Sure, I will write to [EMAIL_1] today."
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      sent.push(request)
      return Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "t" }),
        LLMEvent.textDelta({ id: "t", text: answer.slice(0, 20) }),
        LLMEvent.textDelta({ id: "t", text: answer.slice(20) }),
        LLMEvent.textEnd({ id: "t" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ])
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("generate must go through the unmasking stream"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const request = () =>
  LLM.request({ model, messages: [Message.user("Mail jiwon.kim@example.com the invoice")], tools: [] })

const run = <A, R>(mode: "off" | "regex", effect: Effect.Effect<A, unknown, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(client, Privacy.layerWith({ mode })))) as Effect.Effect<A, unknown>)

describe("chat/completions masking", () => {
  test("off: the request goes out as written and nothing is rewritten", async () => {
    sent.length = 0
    const { request: outgoing, unmask } = await run("off", maskedRequest(request()))
    expect(unmask).toBeUndefined()
    expect(JSON.stringify(outgoing.messages)).toContain("jiwon.kim@example.com")
  })

  test("regex: the provider sees a placeholder and the streamed answer carries the real value", async () => {
    sent.length = 0
    const texts = await run(
      "regex",
      Effect.gen(function* () {
        const { request: outgoing, unmask } = yield* maskedRequest(request())
        expect(unmask).toBeDefined()
        return yield* maskedStream(outgoing, unmask).pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((event) => event.text),
          Stream.runCollect,
        )
      }),
    )
    expect(JSON.stringify(sent[0]!.messages)).not.toContain("jiwon.kim@example.com")
    expect(JSON.stringify(sent[0]!.messages)).toContain("[EMAIL_1]")
    expect([...texts].join("")).toBe("Sure, I will write to jiwon.kim@example.com today.")
  })

  test("regex: the assembled (non-stream) answer is unmasked too", async () => {
    sent.length = 0
    const response = await run(
      "regex",
      Effect.gen(function* () {
        const { request: outgoing, unmask } = yield* maskedRequest(request())
        return yield* maskedGenerate(outgoing, unmask)
      }),
    )
    expect(response.text).toBe("Sure, I will write to jiwon.kim@example.com today.")
    expect(JSON.stringify(sent[0]!.messages)).toContain("[EMAIL_1]")
  })
})
