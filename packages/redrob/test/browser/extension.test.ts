import { afterEach, describe, expect, test } from "bun:test"
import { UserBrowser } from "../../src/browser/extension"
import type { DeskBrowserRequest, DeskBrowserResponse } from "@redrob-code/server/channels"

const READ = [
  "URL: https://example.com/inbox",
  "Title: Inbox",
  "",
  "Three new messages.",
  "",
  "Elements:",
  "[e1] link «Home»",
  "[e2] button «Send»",
  "[e3] textbox «Search»",
].join("\n")

const ready = { state: "ready" as const, name: "Chrome on Windows" }

/** A fake extension behind the daemon's link: tasks end after one poll unless `script` says otherwise. */
function fake(script: { states?: string[]; answer?: string; events?: unknown[]; create?: DeskBrowserResponse } = {}) {
  const calls: DeskBrowserRequest[] = []
  let n = 0
  let polls = 0
  const ask = async (request: DeskBrowserRequest): Promise<DeskBrowserResponse> => {
    calls.push(request)
    if (request.method === "GET" && request.path.startsWith("/browser/task?chatId=")) return { status: 404, browser: ready }
    if (request.method === "POST" && request.path === "/browser/task") return script.create ?? { status: 200, body: { id: `t${++n}` }, browser: ready }
    if (request.method === "POST" && request.path.endsWith("/stop")) return { status: 200, body: { ok: true }, browser: ready }
    const states = script.states ?? ["done"]
    const state = states[Math.min(polls++, states.length - 1)]!
    return {
      status: 200,
      body: { id: `t${n}`, state, events: script.events ?? [], ...(state === "done" ? { answer: script.answer ?? READ } : {}) },
      browser: ready,
    }
  }
  return { ask, calls }
}

afterEach(() => UserBrowser.reset())

describe("UserBrowser.act", () => {
  test("open becomes one task for the extension, from Redrob Code, keyed to the session", async () => {
    const { ask, calls } = fake()
    const result = await UserBrowser.act({ action: "open", url: "https://example.com" }, { sessionID: "ses_1", ask })
    expect(result).toEqual({ kind: "extension", browser: "Chrome on Windows", url: "https://example.com/inbox", text: READ })
    const create = calls.find((call) => call.method === "POST" && call.path === "/browser/task")!
    const body = create.body as { task: string; origin: string; chatId: string; followUp?: string }
    expect(body.origin).toBe("code")
    expect(body.chatId).toBe("code-ses_1")
    expect(body.followUp).toBeUndefined()
    expect(body.task.startsWith("Open https://example.com in this tab.")).toBe(true)
    expect(body.task).toContain("Elements:")
    expect(UserBrowser.line(result)).toBe(
      "Browser: the person's own Chrome (Chrome on Windows), through the Redrob extension.",
    )
  })

  test("the next action follows up in the same task and names the element from the last reading", async () => {
    const { ask, calls } = fake()
    await UserBrowser.act({ action: "open", url: "https://example.com" }, { sessionID: "ses_1", ask })
    await UserBrowser.act({ action: "click", ref: "e2" }, { sessionID: "ses_1", ask })
    const creates = calls.filter((call) => call.method === "POST" && call.path === "/browser/task")
    const second = creates[1]!.body as { task: string; followUp?: string }
    expect(second.followUp).toBe("t1")
    expect(second.task.startsWith("Click [e2] button «Send» from your last reading, once.")).toBe(true)

    await UserBrowser.act({ action: "type", ref: "e3", text: "hello", submit: true }, { sessionID: "ses_1", ask })
    const third = calls.filter((call) => call.method === "POST" && call.path === "/browser/task")[2]!.body as {
      task: string
      followUp?: string
    }
    expect(third.followUp).toBe("t2")
    expect(third.task).toContain("into the field [e3] textbox «Search»")
    expect(third.task).toContain("«hello»")
    expect(third.task).toContain("Then press Enter once.")
  })

  test("a task found for this chat after a restart is followed up", async () => {
    const { ask: base, calls } = fake()
    const ask = async (request: DeskBrowserRequest) =>
      request.path.startsWith("/browser/task?chatId=")
        ? { status: 200, body: { id: "old", state: "done", task: "x", origin: "code", last: 3 }, browser: ready }
        : base(request)
    await UserBrowser.act({ action: "read" }, { sessionID: "ses_9", ask })
    const create = calls.find((call) => call.path === "/browser/task")!.body as { followUp?: string }
    expect(create.followUp).toBe("old")
  })

  test("not reaching the extension falls back with the reason, and the session stays on Chromium", async () => {
    const { ask, calls } = fake({
      create: { status: 0, browser: { state: "none" }, error: "no Chrome with the Redrob extension is connected" },
    })
    const result = await UserBrowser.act({ action: "open", url: "https://example.com" }, { sessionID: "ses_2", ask })
    expect(result).toEqual({ kind: "fallback", reason: "no Chrome with the Redrob extension is connected" })
    expect(UserBrowser.line(result)).toBe(
      "Browser: Redrob Code's own Chromium on this machine (headless). The person's Chrome is not used: no Chrome with the Redrob extension is connected.",
    )
    const before = calls.length
    expect(await UserBrowser.act({ action: "click", ref: "e1" }, { sessionID: "ses_2", ask })).toEqual({
      kind: "fallback",
      reason: "",
    })
    expect(calls.length).toBe(before)
  })

  test("waits through the person's approval in Chrome", async () => {
    const { ask, calls } = fake({ states: ["running", "waiting_approval", "running", "done"] })
    const result = await UserBrowser.act({ action: "click", ref: "e2" }, { sessionID: "ses_4", ask })
    expect(result.kind).toBe("extension")
    expect(calls.filter((call) => call.method === "GET" && call.path.startsWith("/browser/task/")).length).toBe(4)
  })

  test("a question from the browser's agent stops the task and comes back as the result", async () => {
    const { ask, calls } = fake({
      states: ["waiting_approval"],
      events: [{ n: 0, at: 0, kind: "approval_needed", tool: "ask-input", question: "Which account?" }],
    })
    const result = await UserBrowser.act({ action: "read" }, { sessionID: "ses_5", ask })
    expect(result).toMatchObject({ kind: "extension", text: "The browser's agent asks: Which account?" })
    expect(calls.some((call) => call.path === "/browser/task/t1/stop")).toBe(true)
  })

  test("a failed task is an error, not a fallback", async () => {
    const { ask } = fake({ states: ["failed"] })
    await expect(UserBrowser.act({ action: "read" }, { sessionID: "ses_6", ask })).rejects.toThrow("Chrome on Windows")
  })

  test("screenshot in the person's Chrome says to read instead; before any use it falls back", async () => {
    const { ask } = fake()
    expect(await UserBrowser.act({ action: "screenshot" }, { sessionID: "ses_7", ask })).toEqual({ kind: "fallback", reason: "" })
    await UserBrowser.act({ action: "open", url: "https://example.com" }, { sessionID: "ses_8", ask })
    await expect(UserBrowser.act({ action: "screenshot" }, { sessionID: "ses_8", ask })).rejects.toThrow("Use `read`")
  })
})

test("chat ids keep the extension's id shape", () => {
  expect(UserBrowser.chatId("ses_abc.1")).toBe("code-ses_abc_1")
  expect(/^[A-Za-z0-9_-]{1,128}$/.test(UserBrowser.chatId("x".repeat(300)))).toBe(true)
})
