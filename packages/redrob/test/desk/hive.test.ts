import { afterEach, describe, expect, test } from "bun:test"
import { readFile, rm, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { MobileProfile } from "@redrob-code/core/permission/mobile"
import { ChatError, type HiveFinish, type HiveRun } from "../../src/desk/auth"
import { HiveRunner, INTERRUPTED, NO_ANSWER, READ_ONLY, hivePath, outcome, type HiveDaemon } from "../../src/desk/hive"
import { machine, settingsPath, updateMachine } from "../../src/desk/settings"

const quiet = { info: () => undefined, warn: () => undefined }

const run = (id: string): HiveRun => ({
  id,
  scheduleId: "sch_1",
  chatId: "chat_1",
  name: "Morning notes",
  prompt: "Summarise my notes",
  dueAt: new Date().toISOString(),
  status: "due",
})

const answer = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  content: [
    { type: "reasoning", id: "r", text: "thinking" },
    { type: "text", id: "t", text },
  ],
  time: { created: 1, completed: 2 },
  ...extra,
})

/** A chat server holding due runs; claim moves due to running once. */
function fakeChat(due: HiveRun[]) {
  const state = new Map(due.map((r) => [r.id, "due"]))
  const claims: string[] = []
  const finishes: { id: string; body: HiveFinish }[] = []
  let finishFails = 0
  return {
    claims,
    finishes,
    failNextFinishes(n: number) {
      finishFails = n
    },
    setRunning(id: string) {
      state.set(id, "running")
    },
    chat: {
      hiveDue: async () => due.filter((r) => state.get(r.id) === "due"),
      hiveClaim: async (id: string) => {
        claims.push(id)
        if (state.get(id) !== "due") throw new ChatError(409, "no longer due")
        state.set(id, "running")
        return { ...due.find((r) => r.id === id)!, status: "running" }
      },
      hiveFinish: async (id: string, body: HiveFinish) => {
        if (finishFails > 0) {
          finishFails -= 1
          throw new Error("offline")
        }
        if (state.get(id) !== "running") throw new ChatError(409, "not running")
        state.set(id, body.status)
        finishes.push({ id, body })
      },
    },
  }
}

/** An engine whose new session stays active for `busy` looks, then holds `messages`. */
function fakeDaemon(messages: unknown[], busy = 1) {
  const calls: string[] = []
  const daemon: HiveDaemon = {
    raw: (async (method: string, p: string, body?: unknown) => {
      calls.push(`${method} ${p}`)
      if (method === "POST" && p === "/api/session") return { status: 200, body: { data: { id: "ses_hive" } } }
      if (p.endsWith("/prompt")) {
        expect(body).toEqual({ prompt: { text: "Summarise my notes" } })
        return { status: 200, body: { data: {} } }
      }
      if (p === "/api/session/active")
        return { status: 200, body: { data: busy-- > 0 ? { ses_hive: { type: "running" } } : {} } }
      if (p.endsWith("/context")) return { status: 200, body: { data: messages } }
      return { status: 404 }
    }) as HiveDaemon["raw"],
  }
  return { daemon, calls }
}

async function settle(runner: HiveRunner) {
  await runner.tick()
  await Promise.all([...runner.running])
}

afterEach(async () => {
  await rm(hivePath(), { force: true })
  await rm(settingsPath(), { force: true })
})

describe("desk hive outcome", () => {
  test("the last assistant message's text is the answer", () => {
    expect(outcome([{ type: "user" }, answer("first"), answer("final")])).toEqual({ status: "done", text: "final" })
  })
  test("an unfinished turn is not an outcome yet", () => {
    expect(outcome([{ type: "user" }])).toBeUndefined()
    expect(outcome([answer("x", { time: { created: 1 } })])).toBeUndefined()
  })
  test("an error fails the run and keeps any text", () => {
    expect(outcome([answer("half", { error: { type: "unknown", message: "No model" } })])).toEqual({
      status: "failed",
      error: "No model",
      text: "half",
    })
  })
  test("a turn that never answers fails after a while, it does not hang", async () => {
    const server = fakeChat([run("run_a")])
    const { daemon } = fakeDaemon([{ type: "user" }], 0)
    await settle(new HiveRunner(server.chat, daemon, quiet, 1))
    expect(server.finishes.map((f) => [f.body.status, f.body.error])).toEqual([["failed", NO_ANSWER]])
  })
  test("no text fails the run", () => {
    expect(outcome([{ ...answer(""), content: [] }])).toEqual({ status: "failed", error: NO_ANSWER })
  })
})

describe("desk hive runner", () => {
  test("claims one due run, runs it as a session and finishes it with the answer", async () => {
    const self = await machine()
    const server = fakeChat([run("run_a"), run("run_b")])
    const { daemon, calls } = fakeDaemon([{ type: "user" }, answer("Three new notes.")])
    const runner = new HiveRunner(server.chat, daemon, quiet, 1)

    await settle(runner)

    expect(server.claims).toEqual(["run_a"])
    expect(server.finishes).toEqual([
      { id: "run_a", body: { machineId: self.id, status: "done", text: "Three new notes." } },
    ])
    expect(calls).toEqual([
      "POST /api/session",
      "POST /api/session/ses_hive/prompt",
      "GET /api/session/active",
      "GET /api/session/active",
      "GET /api/session/ses_hive/context",
    ])
    // A trusted machine with the launcher's switch on: nobody is at the screen, nothing asks.
    expect(MobileProfile.mode("ses_hive")).toBe("all")
    expect(JSON.parse(await readFile(hivePath(), "utf8"))).toEqual({ runs: {} })

    // The next pass takes the next one; run_a is never run again.
    await settle(runner)
    expect(server.claims).toEqual(["run_a", "run_b"])
  })

  test("a run another claim took is skipped", async () => {
    const server = fakeChat([run("run_a")])
    const chat = { ...server.chat, hiveDue: async () => [run("run_a")] }
    server.setRunning("run_a")
    const { daemon, calls } = fakeDaemon([answer("x")])
    await settle(new HiveRunner(chat, daemon, quiet, 1))
    expect(server.claims).toEqual(["run_a"])
    expect(calls).toEqual([])
    expect(JSON.parse(await readFile(hivePath(), "utf8"))).toEqual({ runs: {} })
  })

  test("a run left over from a restart is finished as failed, not run again", async () => {
    const self = await machine()
    const server = fakeChat([run("run_left")])
    server.setRunning("run_left")
    await mkdir(path.dirname(hivePath()), { recursive: true })
    await writeFile(hivePath(), JSON.stringify({ runs: { run_left: { at: 1, sessionId: "ses_old" } } }))
    const { daemon, calls } = fakeDaemon([answer("x")])
    await settle(new HiveRunner(server.chat, daemon, quiet, 1))
    expect(server.finishes).toEqual([
      { id: "run_left", body: { machineId: self.id, status: "failed", error: INTERRUPTED } },
    ])
    expect(server.claims).toEqual([])
    expect(calls).toEqual([])
  })

  test("a finish the server did not get is kept and sent on the next pass", async () => {
    const server = fakeChat([run("run_a")])
    server.failNextFinishes(1)
    const { daemon } = fakeDaemon([answer("Done.")])
    const runner = new HiveRunner(server.chat, daemon, quiet, 1)
    await settle(runner)
    expect(server.finishes).toEqual([])
    const kept = JSON.parse(await readFile(hivePath(), "utf8")) as { runs: Record<string, { finish?: HiveFinish }> }
    expect(kept.runs.run_a?.finish?.text).toBe("Done.")
    await settle(runner)
    expect(server.finishes.map((f) => [f.id, f.body.status, f.body.text])).toEqual([["run_a", "done", "Done."]])
    expect(server.claims).toEqual(["run_a"])
  })

  test("a read-only machine fails the run without starting a session", async () => {
    await updateMachine({ access: "read_only" })
    const server = fakeChat([run("run_a")])
    const { daemon, calls } = fakeDaemon([answer("x")])
    await settle(new HiveRunner(server.chat, daemon, quiet, 1))
    expect(server.finishes.map((f) => [f.body.status, f.body.error])).toEqual([["failed", READ_ONLY]])
    expect(calls).toEqual([])
  })

  test("signed out (the chat API refuses): nothing runs", async () => {
    const chat = {
      hiveDue: async () => {
        throw new Error("signed_out")
      },
      hiveClaim: async () => {
        throw new Error("unreachable")
      },
      hiveFinish: async () => undefined,
    }
    const { daemon, calls } = fakeDaemon([])
    await settle(new HiveRunner(chat, daemon, quiet, 1))
    expect(calls).toEqual([])
  })
})
