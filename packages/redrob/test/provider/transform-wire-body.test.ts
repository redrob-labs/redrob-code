import { afterAll, expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { ProviderTransform } from "@/provider/transform"

// End-to-end wire check for the options ProviderTransform hands the AI SDK: a real local
// HTTP upstream records the JSON body the provider package actually serializes. Unit
// assertions on `ProviderTransform.options` alone missed that @ai-sdk/openai-compatible
// spreads keys it does not recognize straight into the Chat Completions body, which is how
// camelCase `promptCacheKey` reached Console and failed the first prompt of a session with
// "Unrecognized request argument supplied: promptCacheKey".
const bodies: Record<string, unknown>[] = []
const upstream = Bun.serve({
  port: 0,
  fetch: async (request) => {
    bodies.push((await request.json()) as Record<string, unknown>)
    return new Response("", { headers: { "content-type": "text/event-stream" } })
  },
})
const baseURL = `${upstream.url}v1`

afterAll(() => upstream.stop(true))

const model = (input: { providerID: string; npm: string; id: string }) =>
  ({
    id: `${input.providerID}/${input.id}`,
    providerID: input.providerID,
    api: { id: input.id, url: baseURL, npm: input.npm },
    name: input.id,
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 400_000, output: 128_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-08-01",
  }) as any

const sessionID = "ses_wire_body"

const send = async (language: LanguageModelV3, provider: any) => {
  const options = ProviderTransform.options({ model: provider, sessionID, providerOptions: {} })
  await language.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    providerOptions: ProviderTransform.providerOptions(provider, options),
  })
  return bodies.at(-1)!
}

test("Console gpt-5 models send no camelCase Responses-only fields on the wire", async () => {
  const provider = model({ providerID: "redrob", npm: "@ai-sdk/openai-compatible", id: "gpt-5.6-terra" })
  const body = await send(
    createOpenAICompatible({ name: "redrob", baseURL, apiKey: "rrk_test_secret" }).languageModel("gpt-5.6-terra"),
    provider,
  )

  expect(body["promptCacheKey"]).toBeUndefined()
  expect(body["prompt_cache_key"]).toBeUndefined()
  expect(body["include"]).toBeUndefined()
  expect(body["reasoningSummary"]).toBeUndefined()
  expect(body["reasoning_summary"]).toBeUndefined()
  // The supported knob still reaches Console with its documented wire name.
  expect(body["reasoning_effort"]).toBe("medium")
})

test("real OpenAI gpt-5 models still send prompt caching and encrypted reasoning", async () => {
  const provider = model({ providerID: "openai", npm: "@ai-sdk/openai", id: "gpt-5.6" })
  const body = await send(createOpenAI({ name: "openai", baseURL, apiKey: "sk-test" }).responses("gpt-5.6"), provider)

  expect(body["prompt_cache_key"]).toBe(sessionID)
  expect(body["include"]).toEqual(["reasoning.encrypted_content"])
  expect(body["reasoning"]).toEqual({ effort: "medium", summary: "auto" })
  expect(body["promptCacheKey"]).toBeUndefined()
})
