import { afterEach, beforeEach, describe, expect } from "bun:test"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { httpClient } from "@redrob-code/core/effect/app-node-platform"
import { FSUtil } from "@redrob-code/core/fs-util"
import { Cause, Effect, Exit } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import fs from "fs/promises"
import path from "path"
import { Auth } from "@/auth"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionID, MessageID } from "../../src/session/schema"
import { DEFAULT_SPEECH_MODEL, DEFAULT_SPEECH_VOICE, SpeechGenerateTool } from "../../src/tool/speech_generate"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/** The first bytes of an MP3 frame, which is what a real answer starts with. */
const MP3 = new Uint8Array([0xff, 0xf3, 0x44, 0xc4, 0x00, 0x01, 0x02, 0x03])

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([httpClient, Auth.node, FSUtil.node, EventV2Bridge.node, Truncate.node, Agent.node]),
    [[httpClient, FetchHttpClient.layer]],
  ),
)

type Seen = { path: string; authorization: string | null; body: Record<string, unknown> }

/** A stand-in for the gateway's speech route, recording what reached it. */
function gateway(answer: () => Response) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body: Record<string, unknown> = await request.json()
      seen.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), body })
      return answer()
    },
  })
  return { seen, server }
}

const audioAnswer = () =>
  new Response(MP3, { headers: { "content-type": "audio/mpeg", "x-redrob-cost-usd": "0.000042" } })

const asks: unknown[] = []
const ctx = {
  sessionID: SessionID.make("ses_test-speech"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (request: unknown) => Effect.sync(() => void asks.push(request)),
}

const run = Effect.fn("SpeechGenerateToolTest.run")(function* (args: Tool.InferParameters<typeof SpeechGenerateTool>) {
  const info = yield* SpeechGenerateTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

const failure = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")

const saved = {
  url: process.env.REDROB_CONSOLE_URL,
  auth: process.env.REDROB_AUTH_CONTENT,
  key: process.env.REDROB_API_KEY,
}

beforeEach(() => {
  asks.length = 0
  process.env.REDROB_AUTH_CONTENT = JSON.stringify({ redrob: { type: "api", key: "rk_test_key" } })
  delete process.env.REDROB_API_KEY
})

afterEach(async () => {
  for (const [name, value] of [
    ["REDROB_CONSOLE_URL", saved.url],
    ["REDROB_AUTH_CONTENT", saved.auth],
    ["REDROB_API_KEY", saved.key],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await disposeAllInstances()
})

describe("tool.speech_generate", () => {
  it.instance("speaks the text through the gateway on the engine's key and saves an mp3, with no attachment", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { seen, server } = gateway(audioAnswer)
      process.env.REDROB_CONSOLE_URL = server.url.toString()
      try {
        const result = yield* run({ text: "안녕하세요, quarterly update." })

        expect(seen).toHaveLength(1)
        expect(seen[0].path).toBe("/audio/speech")
        expect(seen[0].authorization).toBe("Bearer rk_test_key")
        expect(seen[0].body).toEqual({
          model: DEFAULT_SPEECH_MODEL,
          input: "안녕하세요, quarterly update.",
          response_format: "mp3",
          voice: DEFAULT_SPEECH_VOICE,
        })

        const filepath = path.join(test.directory, "artifacts", "quarterly-update.mp3")
        expect(new Uint8Array(yield* Effect.promise(() => fs.readFile(filepath)))).toEqual(MP3)
        expect(result.output).toContain("artifacts")
        expect(result.output).toContain("quarterly-update.mp3")
        // 24 code points: five Hangul syllables, ", ", "quarterly", " ", "update." (as the gateway bills).
        expect(result.metadata).toMatchObject({
          filepath,
          model: DEFAULT_SPEECH_MODEL,
          characters: 24,
          costUsd: 0.000042,
        })
        expect(result.attachments).toBeUndefined()
        expect(asks).toEqual([expect.objectContaining({ permission: "edit" })])
      } finally {
        void server.stop(true)
      }
    }),
  )

  it.instance("a named model gets no default voice, and an existing file is never overwritten", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const existing = path.join(test.directory, "artifacts", "intro.mp3")
      yield* Effect.promise(() => fs.mkdir(path.dirname(existing), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(existing, "keep me"))
      const { seen, server } = gateway(audioAnswer)
      process.env.REDROB_CONSOLE_URL = server.url.toString()
      try {
        const result = yield* run({ text: "Hello", model: "hexgrad/kokoro-82m", filename: "intro" })
        expect(seen[0].body.voice).toBeUndefined()
        expect(seen[0].body.model).toBe("hexgrad/kokoro-82m")
        expect(result.title.endsWith(path.join("artifacts", "intro-2.mp3"))).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(existing, "utf8"))).toBe("keep me")
      } finally {
        void server.stop(true)
      }
    }),
  )

  it.instance("text over the limit, or no key, is refused before anything is sent", () =>
    Effect.gen(function* () {
      const { seen, server } = gateway(audioAnswer)
      process.env.REDROB_CONSOLE_URL = server.url.toString()
      try {
        const long = yield* run({ text: "가".repeat(4097) }).pipe(Effect.exit)
        expect(failure(long)).toContain("The text is 4097 characters")
        process.env.REDROB_AUTH_CONTENT = JSON.stringify({})
        const keyless = yield* run({ text: "Hello" }).pipe(Effect.exit)
        expect(failure(keyless)).toContain("Connect Redrob to generate speech")
        expect(seen).toHaveLength(0)
      } finally {
        void server.stop(true)
      }
    }),
  )

  it.instance("a gateway refusal is relayed, and an answer that is not audio is not saved", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const refusal = gateway(() =>
        Response.json({ error: { message: "Model `x` has no voice `y`." } }, { status: 400 }),
      )
      process.env.REDROB_CONSOLE_URL = refusal.server.url.toString()
      try {
        const exit = yield* run({ text: "Hello", model: "x", voice: "y" }).pipe(Effect.exit)
        expect(failure(exit)).toContain("answered 400: Model `x` has no voice `y`.")
      } finally {
        void refusal.server.stop(true)
      }

      const json = gateway(() => Response.json({ ok: true }))
      process.env.REDROB_CONSOLE_URL = json.server.url.toString()
      try {
        const exit = yield* run({ text: "Hello" }).pipe(Effect.exit)
        expect(failure(exit)).toContain("not audio")
        const written = yield* Effect.promise(() => fs.readdir(path.join(test.directory, "artifacts")).catch(() => []))
        expect(written).toEqual([])
      } finally {
        void json.server.stop(true)
      }
    }),
  )
})
