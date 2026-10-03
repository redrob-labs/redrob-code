import { describe, expect, test } from "bun:test"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { Tool } from "@/tool/tool"
import * as Truncate from "@/tool/truncate"
import { CODE_MODE_TOOL, CodeModeTool, describeCatalog } from "@/tool/code-mode"
import {
  DOMAIN_GLOBALS,
  DomainUnavailableError,
  channelTools,
  domainTools,
  pageTools,
  sessionChannel,
  unavailableChannel,
  bridgedPage,
  unavailablePage,
} from "@/tool/domain"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type { SessionV1 } from "@redrob-code/core/v1/session"
import { BrowserRequestV1 } from "@redrob-code/core/browser-request"
import { Cause, Effect, Exit, Layer } from "effect"

const sessionID = SessionID.make("ses_domain")
const messageID = MessageID.make("msg_domain")

const ctx: Tool.Context = {
  sessionID,
  messageID,
  agent: "build",
  abort: new AbortController().signal,
  callID: "call_domain",
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

/** Collects the parts a program writes, so `channel.send` is asserted on its effect. */
function recordingSessions() {
  const parts: SessionV1.Part[] = []
  const sessions = {
    get: () => Effect.succeed({ permission: [] } as any),
    updatePart: (part: SessionV1.Part) =>
      Effect.sync(() => {
        parts.push(part)
        return part
      }),
  }
  return { parts, sessions }
}

/**
 * A browser channel that never gets a client. The default for the harness, because that is
 * the state of a session with no browser attached, and it is the state the PA-10 refusal
 * messages are written for.
 *
 * It fails immediately rather than sleeping to the service's real deadline: the deadline
 * itself is the service's own test, and a 20s sleep in every page test here would buy
 * nothing.
 */
function unansweredBrowser(): BrowserRequestV1.Interface {
  return {
    ask: (input) => Effect.fail(new BrowserRequestV1.UnansweredError({ action: input.command.action })),
    reply: () => Effect.void,
    refuse: () => Effect.void,
    list: () => Effect.succeed([]),
  }
}

function harness(sessions: Record<string, unknown>, browser: BrowserRequestV1.Interface = unansweredBrowser()) {
  return Layer.mergeAll(
    Layer.mock(Plugin.Service, {
      trigger: ((_name, _input, output) => Effect.succeed(output)) as Plugin.Interface["trigger"],
    }),
    Layer.mock(Truncate.Service, {
      output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
    }),
    Layer.mock(Agent.Service, { get: () => Effect.succeed({ name: "build", permission: [] } as any) }),
    Layer.mock(Session.Service, sessions as any),
    Layer.mock(MCP.Service, { tools: () => Effect.succeed({}), clients: () => Effect.succeed({}) }),
    Layer.mock(BrowserRequestV1.Service, browser),
  )
}

/** Runs one Code Mode program through the real `execute` tool. */
function run(code: string, sessions: Record<string, unknown>, browser?: BrowserRequestV1.Interface) {
  return Effect.runPromise(
    CodeModeTool.pipe(
      Effect.flatMap(Tool.init),
      Effect.flatMap((def) => def.execute({ code }, ctx)),
      Effect.provide(harness(sessions, browser)),
    ),
  )
}

/** Program failures die at the tool boundary; recover the defect for message assertions. */
async function failureOf(code: string, sessions: Record<string, unknown>, browser?: BrowserRequestV1.Interface) {
  const exit = await Effect.runPromise(
    CodeModeTool.pipe(
      Effect.flatMap(Tool.init),
      Effect.flatMap((def) => def.execute({ code }, ctx)),
      Effect.provide(harness(sessions, browser)),
      Effect.exit,
    ),
  )
  if (Exit.isSuccess(exit)) throw new Error("expected the program to fail")
  return (Cause.squash(exit.cause) as Error).message
}

describe("K-1 typed domain objects", () => {
  test("every global names a namespace of the domain tool tree", () => {
    const tools = domainTools({ page: unavailablePage(), channel: unavailableChannel() })
    expect([...(DOMAIN_GLOBALS as ReadonlyArray<string>)].toSorted()).toStrictEqual(Object.keys(tools).toSorted())
  })

  test("the tool names are the interface method names", () => {
    expect(Object.keys(pageTools(unavailablePage())).toSorted()).toStrictEqual([
      "click",
      "navigate",
      "query",
      "text",
      "type",
      "url",
    ])
    expect(Object.keys(channelTools(unavailableChannel())).toSorted()).toStrictEqual(["id", "send"])
  })

  test("the globals are advertised in the catalog description", () => {
    const instructions = describeCatalog({}, [])
    expect(instructions).toContain("## Domain globals")
    expect(instructions).toContain("`page`")
    expect(instructions).toContain("`channel`")
  })

  describe("channel", () => {
    test("send posts a text part into the session that owns the run", async () => {
      const { parts, sessions } = recordingSessions()
      const result = await run('return await channel.send({ text: "posted by a skill" })', sessions)
      expect(result.output).toStartWith("prt_")
      expect(parts).toHaveLength(1)
      expect(parts[0]).toMatchObject({
        type: "text",
        text: "posted by a skill",
        sessionID,
        messageID,
      })
    })

    test("id returns the session the program is bound to", async () => {
      const { sessions } = recordingSessions()
      expect((await run("return await channel.id({})", sessions)).output).toBe(sessionID)
    })

    test("the bare global and the tools path are the same call", async () => {
      const { parts, sessions } = recordingSessions()
      await run('await channel.send({ text: "a" }); return await tools.channel.send({ text: "b" })', sessions)
      expect(parts.map((part) => (part.type === "text" ? part.text : undefined))).toStrictEqual(["a", "b"])
    })
  })

  describe("page with no browser attached refuses rather than faking", () => {
    test("every method refuses, naming the missing capability", async () => {
      const page = unavailablePage()
      const calls = [
        page.url(),
        page.text(),
        page.query({ selector: "h1" }),
        page.click({ selector: "h1" }),
        page.type({ selector: "input", text: "x" }),
        page.navigate({ url: "https://example.invalid" }),
      ]
      for (const call of calls) {
        const exit = await Effect.runPromise(call.pipe(Effect.exit))
        expect(Exit.isFailure(exit)).toBe(true)
        const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        expect(error).toBeInstanceOf(DomainUnavailableError)
        expect((error as DomainUnavailableError).message).toContain("no browser client is attached")
      }
    })

    test("a program calling page.text fails with that reason, not an empty string", async () => {
      const { sessions } = recordingSessions()
      const message = await failureOf("return await page.text({})", sessions)
      expect(message).toContain("`page` domain object is not available")
      // The bridge's reason, not the no-channel one: a channel exists, nobody answered on it.
      expect(message).toContain("no browser client answered page.text")
    })

    test("the refusal carries the named object", () => {
      const error = new DomainUnavailableError({ object: "page", missing: "nothing drives a page here" })
      expect(error.message).toBe(
        "The `page` domain object is not available in this session: nothing drives a page here",
      )
    })
  })

  test("the execute tool still reports its own name", async () => {
    const { sessions } = recordingSessions()
    const result = await run('return await channel.send({ text: "t" })', sessions)
    expect(result.title).toBe(CODE_MODE_TOOL)
  })

  test("PartID is the id shape channel.send returns", () => {
    expect(PartID.ascending()).toStartWith("prt_")
  })
})

/**
 * PA-10. These are the tests that say the channel carries real work, rather than that it
 * refuses politely: a program reads what the attached client answered, and a client that
 * answers with the wrong shape is reported as a protocol error instead of being read as a
 * fact about the page.
 */
describe("PA-10 page over the browser channel", () => {
  /** A client that answers every action, recording what it was asked. */
  function answeringBrowser(value: BrowserRequestV1.Value) {
    const asked: BrowserRequestV1.Command[] = []
    const browser: BrowserRequestV1.Interface = {
      ask: (input) =>
        Effect.sync(() => {
          asked.push(input.command)
          return value
        }),
      reply: () => Effect.void,
      refuse: () => Effect.void,
      list: () => Effect.succeed([]),
    }
    return { asked, browser }
  }

  test("page.text returns what the client answered", async () => {
    const { sessions } = recordingSessions()
    const { asked, browser } = answeringBrowser({ type: "string", value: "the page said this" })
    const result = await run("return await page.text({})", sessions, browser)
    expect(result.output).toContain("the page said this")
    expect(asked.map((command) => command.action)).toStrictEqual(["page.text"])
  })

  test("the selector and the submit flag reach the client, not just the action name", async () => {
    const { sessions } = recordingSessions()
    const { asked, browser } = answeringBrowser({ type: "void" })
    await run('return await page.type({ selector: "#q", text: "hello", submit: true })', sessions, browser)
    expect(asked).toStrictEqual([{ action: "page.type", selector: "#q", text: "hello", submit: true }])
  })

  test("page.query returns the client's nodes", async () => {
    const { sessions } = recordingSessions()
    const { browser } = answeringBrowser({
      type: "nodes",
      value: [{ selector: "h1", text: "Title", attributes: { id: "top" } }],
    })
    const result = await run('return (await page.query({ selector: "h1" }))[0].text', sessions, browser)
    expect(result.output).toContain("Title")
  })

  test("a wrong-shaped answer is a protocol error, NOT an empty result", async () => {
    const { sessions } = recordingSessions()
    // The client answers `page.query` with a string. Reading that as zero nodes would tell
    // the model "nothing matched the selector", which is a claim about the page that nobody
    // made.
    const { browser } = answeringBrowser({ type: "string", value: "h1" })
    const message = await failureOf('return await page.query({ selector: "h1" })', sessions, browser)
    expect(message).toContain("answered page.query with a string value where nodes was required")
  })

  test("a refusal from the client carries its own sentence through", async () => {
    const { sessions } = recordingSessions()
    const browser: BrowserRequestV1.Interface = {
      ask: () =>
        Effect.fail(new BrowserRequestV1.RefusedError({ action: "page.click", reason: "that tab is not shared" })),
      reply: () => Effect.void,
      refuse: () => Effect.void,
      list: () => Effect.succeed([]),
    }
    const message = await failureOf('return await page.click({ selector: "h1" })', sessions, browser)
    expect(message).toContain("the browser refused page.click: that tab is not shared")
  })

  test("bridgedPage asks with the session that owns the run", async () => {
    const asked: BrowserRequestV1.AskInput[] = []
    const page = bridgedPage({
      sessionID,
      browser: {
        ask: (input) =>
          Effect.sync(() => {
            asked.push(input)
            return { type: "string", value: "https://example.invalid/" } as const
          }),
        reply: () => Effect.void,
        refuse: () => Effect.void,
        list: () => Effect.succeed([]),
      },
    })
    const url = await Effect.runPromise(page.url())
    expect(url).toBe("https://example.invalid/")
    expect(asked.map((input) => input.sessionID)).toStrictEqual([sessionID])
  })
})
