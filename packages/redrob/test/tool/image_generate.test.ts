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
import { DEFAULT_IMAGE_MODEL, ImageGenerateTool, decodeImageDataUrl, slug } from "../../src/tool/image_generate"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/** A real one-pixel PNG, so the bytes written are an image rather than filler. */
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([httpClient, Auth.node, FSUtil.node, EventV2Bridge.node, Truncate.node, Agent.node]),
    [[httpClient, FetchHttpClient.layer]],
  ),
)

type Seen = { authorization: string | null; body: Record<string, unknown> }

/** A stand-in for the Redrob gateway that records what reached it. */
function gateway(answer: (body: Record<string, unknown>) => Response) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body: Record<string, unknown> = await request.json()
      seen.push({ authorization: request.headers.get("authorization"), body })
      return answer(body)
    },
  })
  return { seen, server }
}

const imageAnswer = () =>
  Response.json({
    choices: [
      {
        message: {
          content: "A red square.",
          images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PIXEL_PNG}` } }],
        },
      },
    ],
    redrob: { costUsd: 0.039 },
  })

const asks: unknown[] = []
const ctx = {
  sessionID: SessionID.make("ses_test-image"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (request: unknown) => Effect.sync(() => void asks.push(request)),
}

const run = Effect.fn("ImageGenerateToolTest.run")(function* (args: Tool.InferParameters<typeof ImageGenerateTool>) {
  const info = yield* ImageGenerateTool
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

describe("tool.image_generate", () => {
  it.instance("asks the gateway for an image on the engine's Redrob key, saves it, and attaches it", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { seen, server } = gateway(imageAnswer)
      process.env.REDROB_CONSOLE_URL = server.url.toString()
      try {
        const result = yield* run({ prompt: "A small red square on white" })

        expect(seen).toHaveLength(1)
        expect(seen[0].authorization).toBe("Bearer rk_test_key")
        expect(seen[0].body).toMatchObject({
          model: DEFAULT_IMAGE_MODEL,
          modalities: ["image", "text"],
          messages: [{ role: "user", content: "A small red square on white" }],
        })

        const filepath = path.join(test.directory, "artifacts", "a-small-red-square-on-white.png")
        expect(Buffer.from(yield* Effect.promise(() => fs.readFile(filepath))).toString("base64")).toBe(PIXEL_PNG)
        expect(result.title.endsWith(path.join("artifacts", "a-small-red-square-on-white.png"))).toBe(true)
        expect(result.output).toContain("A red square.")
        expect(result.metadata).toMatchObject({ filepath, model: DEFAULT_IMAGE_MODEL, costUsd: 0.039 })
        expect(result.attachments).toEqual([
          {
            type: "file",
            mime: "image/png",
            filename: "a-small-red-square-on-white.png",
            url: `data:image/png;base64,${PIXEL_PNG}`,
          },
        ])
        expect(asks).toEqual([expect.objectContaining({ permission: "edit", patterns: [result.title] })])
      } finally {
        void server.stop(true)
      }
    }),
  )

  it.instance("never overwrites an existing file, and uses a named model and file name", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const existing = path.join(test.directory, "artifacts", "logo.png")
      yield* Effect.promise(() => fs.mkdir(path.dirname(existing), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(existing, "keep me"))
      const { seen, server } = gateway(imageAnswer)
      process.env.REDROB_CONSOLE_URL = server.url.toString()
      try {
        const result = yield* run({ prompt: "A logo", filename: "Logo", model: "openai/gpt-5-image-mini" })
        expect(seen[0].body.model).toBe("openai/gpt-5-image-mini")
        expect(result.title.endsWith(path.join("artifacts", "logo-2.png"))).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(existing, "utf8"))).toBe("keep me")
      } finally {
        void server.stop(true)
      }
    }),
  )

  it.instance("fails with what the model said when it returns no image", () =>
    Effect.gen(function* () {
      const { server } = gateway(() => Response.json({ choices: [{ message: { content: "I cannot draw that." } }] }))
      process.env.REDROB_CONSOLE_URL = server.url.toString()
      try {
        const exit = yield* run({ prompt: "Something" }).pipe(Effect.exit)
        expect(failure(exit)).toContain("returned no image. It said: I cannot draw that.")
      } finally {
        void server.stop(true)
      }
    }),
  )

  it.instance("relays the gateway's own refusal, such as an empty balance", () =>
    Effect.gen(function* () {
      const { server } = gateway(() =>
        Response.json(
          { error: { message: "This workspace is out of credit.", type: "insufficient_quota" } },
          { status: 402 },
        ),
      )
      process.env.REDROB_CONSOLE_URL = server.url.toString()
      try {
        const exit = yield* run({ prompt: "Something" }).pipe(Effect.exit)
        expect(failure(exit)).toContain("answered 402: This workspace is out of credit.")
      } finally {
        void server.stop(true)
      }
    }),
  )

  it.instance("without a Redrob key it fails before anything is sent", () =>
    Effect.gen(function* () {
      process.env.REDROB_AUTH_CONTENT = JSON.stringify({})
      const { seen, server } = gateway(imageAnswer)
      process.env.REDROB_CONSOLE_URL = server.url.toString()
      try {
        const exit = yield* run({ prompt: "Something" }).pipe(Effect.exit)
        expect(failure(exit)).toContain("Connect Redrob to generate images")
        expect(seen).toHaveLength(0)
      } finally {
        void server.stop(true)
      }
    }),
  )
})

describe("image_generate helpers", () => {
  it.effect("derives a safe file name stem", () =>
    Effect.sync(() => {
      expect(slug("A Red Square, on white!")).toBe("a-red-square-on-white")
      expect(slug("../../etc/passwd")).toBe("etc-passwd")
      expect(slug("로고")).toBe("image")
      expect(slug("x".repeat(100))).toHaveLength(48)
    }),
  )

  it.effect("accepts only inline images of a type it writes", () =>
    Effect.sync(() => {
      expect(decodeImageDataUrl(`data:image/png;base64,${PIXEL_PNG}`)?.mime).toBe("image/png")
      expect(decodeImageDataUrl("https://example.com/a.png")).toBeUndefined()
      expect(decodeImageDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBeUndefined()
      expect(decodeImageDataUrl("data:text/html;base64,PGI+")).toBeUndefined()
    }),
  )
})
