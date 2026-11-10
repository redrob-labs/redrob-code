/**
 * The runner browser as a tool of the session engine sessions started over the desk run on
 * (core `session.next`, core/src/tool/builtins.ts). `tool/browser.ts` is the same tool for the
 * older registry; without this one a web/phone session had no `browser` tool, so the panel's
 * browser tab never got a page to show.
 *
 * `node` stands in for core's `built-in-tools` node (same name, so it can replace it in the
 * location graph): every built-in, plus `browser` where a Chromium is installed.
 */
import { ToolFailure } from "@redrob-code/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "@redrob-code/core/effect/app-node"
import { PermissionV2 } from "@redrob-code/core/permission"
import { BuiltInTools } from "@redrob-code/core/tool/builtins"
import { ToolRegistry } from "@redrob-code/core/tool/registry"
import { Tool } from "@redrob-code/core/tool/tool"
import { Tools } from "@redrob-code/core/tool/tools"
import DESCRIPTION from "../tool/browser.txt"
import { Parameters } from "../tool/browser"
import { RunnerBrowser } from "."

export const name = "browser"

const Output = Schema.Struct({
  url: Schema.String,
  text: Schema.String,
  /** JPEG base64, for `screenshot`. */
  jpegBase64: Schema.optional(Schema.String),
})

type Input = Schema.Schema.Type<typeof Parameters>

const need = (value: string | undefined, message: string): string => {
  if (value === undefined || value === "") throw new Error(message)
  return value
}

async function act(input: Input): Promise<Schema.Schema.Type<typeof Output>> {
  const handedBack = await RunnerBrowser.turn()
  const lead = handedBack ? `${handedBack}\n\n` : ""
  if (input.action === "screenshot") {
    const shot = await RunnerBrowser.screenshot()
    return { url: shot.url, text: `${lead}Screenshot of ${shot.url} attached.`, jpegBase64: shot.jpegBase64 }
  }
  const reading = await (() => {
    switch (input.action) {
      case "open": {
        const url = need(input.url, "open needs `url`.")
        if (!/^https?:\/\//i.test(url)) throw new Error("open takes an http:// or https:// URL.")
        return RunnerBrowser.open(url)
      }
      case "read":
        return RunnerBrowser.read()
      case "click":
        return RunnerBrowser.click(need(input.ref, "click needs `ref`."))
      case "type":
        return RunnerBrowser.type(need(input.ref, "type needs `ref`."), input.text ?? "", input.submit)
      case "scroll":
        return RunnerBrowser.scroll({ ref: input.ref, direction: input.direction, amount: input.amount })
      case "wait":
        return RunnerBrowser.wait({ text: input.text, seconds: input.seconds })
    }
  })()
  return { url: reading.url, text: `${lead}URL: ${reading.url}\nTitle: ${reading.title}\n\n${reading.text}` }
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!(yield* Effect.promise(() => RunnerBrowser.available()))) return
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description: DESCRIPTION,
          input: Parameters,
          output: Output,
          toModelOutput: ({ output }) => [
            { type: "text", text: output.text },
            ...(output.jpegBase64 ? [{ type: "file" as const, data: output.jpegBase64, mime: "image/jpeg" }] : []),
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.action === "open")
                yield* permission.assert({
                  action: name,
                  resources: [input.url ?? ""],
                  save: ["*"],
                  metadata: { url: input.url },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
              return yield* Effect.tryPromise({
                try: () => act(input),
                catch: (error) => new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
              })
            }).pipe(
              Effect.catch((error) =>
                Effect.fail(error instanceof ToolFailure ? error : new ToolFailure({ message: String(error) })),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

const browserNode = makeLocationNode({
  name: "tool/browser",
  layer,
  deps: () => [ToolRegistry.node, PermissionV2.node],
})

export const node = makeLocationNode({
  name: BuiltInTools.node.name,
  layer: Layer.empty,
  deps: () => [browserNode, ...BuiltInTools.node.dependencies] as const,
})

export * as BrowserTools from "./tool"
