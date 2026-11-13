import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser.txt"
import { RunnerBrowser } from "@/browser"
import { UserBrowser } from "@/browser/extension"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["open", "read", "click", "type", "scroll", "wait", "screenshot"]).annotate({
    description: "What to do",
  }),
  url: Schema.optional(Schema.String).annotate({ description: "For open: http(s) URL" }),
  ref: Schema.optional(Schema.String).annotate({
    description: "For click, type, scroll: element number from the latest reading, like e5",
  }),
  text: Schema.optional(Schema.String).annotate({ description: "For type: the text. For wait: text to wait for" }),
  submit: Schema.optional(Schema.Boolean).annotate({ description: "For type: press Enter after typing" }),
  direction: Schema.optional(Schema.Literals(["down", "up"])).annotate({ description: "For scroll" }),
  amount: Schema.optional(Schema.Number).annotate({ description: "For scroll: pixels (default 600)" }),
  seconds: Schema.optional(Schema.Number).annotate({ description: "For wait: seconds, at most 60" }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type Metadata = {
  action: Params["action"]
  url?: string
  handedBack?: string
  browser?: "chrome" | "own"
  /** While the call waits for Allow in the person's Chrome. */
  pairing?: { code: string; name: string }
  /** No Chrome with the extension was found; the TUI says how to connect (once per session). */
  connect?: boolean
}

const need = <A>(value: A | undefined, message: string): A => {
  if (value === undefined || value === "") throw new Error(message)
  return value
}

function run(params: Params): Promise<RunnerBrowser.Reading> {
  switch (params.action) {
    case "open": {
      const url = need(params.url, "open needs `url`.")
      if (!/^https?:\/\//i.test(url)) throw new Error("open takes an http:// or https:// URL.")
      return RunnerBrowser.open(url)
    }
    case "read":
      return RunnerBrowser.read()
    case "click":
      return RunnerBrowser.click(need(params.ref, "click needs `ref`."))
    case "type":
      return RunnerBrowser.type(need(params.ref, "type needs `ref`."), params.text ?? "", params.submit)
    case "scroll":
      return RunnerBrowser.scroll({ ref: params.ref, direction: params.direction, amount: params.amount })
    case "wait":
      return RunnerBrowser.wait({ text: params.text, seconds: params.seconds })
    case "screenshot":
      throw new Error("unreachable")
  }
}

export const BrowserTool = Tool.define<typeof Parameters, Metadata, never>(
  "browser",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          if (params.action === "open")
            yield* ctx.ask({
              permission: "browser",
              patterns: [params.url ?? ""],
              always: ["*"],
              metadata: { url: params.url },
            })
          if (params.action === "open" && !/^https?:\/\//i.test(params.url ?? ""))
            throw new Error("open takes an http:// or https:// URL.")
          // The person's own Chrome through the Redrob extension when it is linked; else our Chromium.
          // While the first call waits for Allow in Chrome, the row shows the code (metadata.pairing).
          const user = yield* Effect.promise(() =>
            UserBrowser.act(params, {
              sessionID: ctx.sessionID,
              signal: ctx.abort,
              onPairing: (pairing) =>
                void Effect.runPromise(
                  ctx.metadata({ metadata: { action: params.action, ...(pairing ? { pairing } : {}) } }),
                ).catch(() => undefined),
            }),
          )
          if (user.kind === "extension")
            return {
              title: `${params.action} ${user.url} (your Chrome)`,
              output: `${UserBrowser.line(user)}\n${user.text}`,
              metadata: { action: params.action, url: user.url, browser: "chrome" as const },
            }
          const browserLine = UserBrowser.line(user)
          const handedBack = yield* Effect.promise(() => RunnerBrowser.turn(ctx.abort))
          const lead = `${browserLine}\n${handedBack ? `${handedBack}\n\n` : ""}`
          const meta = {
            action: params.action,
            browser: "own" as const,
            ...(handedBack ? { handedBack } : {}),
            ...(user.connect ? { connect: true } : {}),
          }

          if (params.action === "screenshot") {
            const shot = yield* Effect.promise(() => RunnerBrowser.screenshot())
            return {
              title: `Screenshot of ${shot.url}`,
              output: `${lead}Screenshot of ${shot.url} attached.`,
              metadata: { ...meta, url: shot.url },
              attachments: [
                { type: "file" as const, mime: "image/jpeg", url: `data:image/jpeg;base64,${shot.jpegBase64}` },
              ],
            }
          }

          const reading = yield* Effect.promise(() => run(params))
          return {
            title: `${params.action} ${reading.url}`,
            output: `${lead}URL: ${reading.url}\nTitle: ${reading.title}\n\n${reading.text}`,
            metadata: { ...meta, url: reading.url },
          }
          // A rejected promise dies with its error, which becomes the tool call's error text.
        }).pipe(Effect.orDie),
    }
  }),
)
