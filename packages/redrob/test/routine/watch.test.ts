import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { RoutineWatch } from "../../src/routine/watch"
import { normalizeTrigger } from "../../src/routine/store"
import { Result } from "effect"

describe("routine watch subject", () => {
  test("checks each kind", () => {
    expect(RoutineWatch.subject({ kind: "github_pr", url: "https://github.com/o/r/pull/12/" })).toEqual({
      kind: "github_pr",
      url: "https://github.com/o/r/pull/12",
    })
    expect(RoutineWatch.subject({ kind: "ci_run", url: "https://github.com/o/r/actions/runs/123/job/9" })).toEqual({
      kind: "ci_run",
      url: "https://github.com/o/r/actions/runs/123/job/9",
    })
    expect(typeof RoutineWatch.subject({ kind: "ci_run", url: "https://github.com/o/r/pull/1" })).toBe("string")
    expect(RoutineWatch.subject({ kind: "url", url: "https://dev.redrob.ai/health" })).toEqual({
      kind: "url",
      url: "https://dev.redrob.ai/health",
    })
    expect(typeof RoutineWatch.subject({ kind: "url", url: "file:///etc/passwd" })).toBe("string")
    expect(RoutineWatch.subject({ kind: "command", command: "  bun test  " })).toEqual({
      kind: "command",
      command: "bun test",
    })
    expect(typeof RoutineWatch.subject({ kind: "command" })).toBe("string")
    expect(typeof RoutineWatch.subject({ kind: "nope", url: "https://x.y" })).toBe("string")
  })

  test("normalizeTrigger keeps the old pull request shape and stores the new kinds", () => {
    expect(
      Result.getOrThrow(normalizeTrigger({ type: "watch", kind: "github_pr", url: "https://github.com/o/r/pull/1" })),
    ).toEqual({ type: "watch", kind: "github_pr", url: "https://github.com/o/r/pull/1", interval: 300 })
    expect(
      Result.getOrThrow(normalizeTrigger({ type: "watch", kind: "command", command: "make check", interval: 60 })),
    ).toEqual({ type: "watch", kind: "command", command: "make check", interval: 60 })
    expect(Result.isFailure(normalizeTrigger({ type: "watch", kind: "url", url: "https://x.y", interval: 5 }))).toBe(true)
  })

  test("labels", () => {
    expect(RoutineWatch.label({ kind: "github_pr", url: "https://github.com/o/r/pull/12" })).toBe("o/r#12")
    expect(RoutineWatch.label({ kind: "ci_run", url: "https://github.com/o/r/actions/runs/77" })).toBe("o/r CI 77")
    expect(RoutineWatch.label({ kind: "url", url: "https://a.b/c" })).toBe("https://a.b/c")
    expect(RoutineWatch.label({ kind: "command", command: "x".repeat(100) })).toHaveLength(80)
  })

  test("CI run facts and change text", () => {
    const before = RoutineWatch.runFacts({ status: "in_progress", conclusion: null, jobs: [{ name: "test", status: "in_progress" }] })
    const after = RoutineWatch.runFacts({
      status: "completed",
      conclusion: "failure",
      jobs: [{ name: "test", status: "completed", conclusion: "failure" }],
    })
    const target = { kind: "ci_run", url: "https://github.com/o/r/actions/runs/1" } as const
    const text = RoutineWatch.describe(target, RoutineWatch.factsFingerprint(before), {
      fingerprint: RoutineWatch.factsFingerprint(after),
      finished: true,
      state: "completed/failure",
    })
    expect(text).toContain("is now completed/failure")
    expect(text).toContain("status: in_progress -> completed")
    expect(text).toContain("job test: in_progress -> failure")
    expect(RoutineWatch.parseFacts(RoutineWatch.factsFingerprint(after))).toEqual(after)
  })
})

describe("routine watch observe", () => {
  const dir = path.join(os.tmpdir(), `routine-watch-${process.pid}`)
  afterAll(() => fs.rm(dir, { recursive: true, force: true }))

  test("url: wakes on a status change, unreachable included", async () => {
    let status = 503
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x", { status }) })
    const target = { kind: "url", url: `http://127.0.0.1:${server.port}/health` } as const
    const first = await Effect.runPromise(RoutineWatch.observe(target, os.tmpdir()))
    expect(first.state).toBe("HTTP 503")
    status = 200
    const second = await Effect.runPromise(RoutineWatch.observe(target, os.tmpdir()))
    expect(second.fingerprint).not.toBe(first.fingerprint)
    expect(RoutineWatch.describe(target, first.fingerprint, second)).toContain("status: 503 -> 200")
    server.stop(true)
    const third = await Effect.runPromise(RoutineWatch.observe(target, os.tmpdir()))
    expect(third.state).toBe("unreachable")
  })

  test("command: runs in the routine's folder, wakes on exit code or output", async () => {
    await fs.mkdir(dir, { recursive: true })
    const target = { kind: "command", command: "cat state.txt" } as const
    await fs.writeFile(path.join(dir, "state.txt"), "building\n")
    const first = await Effect.runPromise(RoutineWatch.observe(target, dir))
    expect(first.state).toBe("exit 0")
    const same = await Effect.runPromise(RoutineWatch.observe(target, dir))
    expect(same.fingerprint).toBe(first.fingerprint)
    await fs.writeFile(path.join(dir, "state.txt"), "deployed\n")
    const changed = await Effect.runPromise(RoutineWatch.observe(target, dir))
    expect(changed.fingerprint).not.toBe(first.fingerprint)
    const text = RoutineWatch.describe(target, first.fingerprint, changed)
    expect(text).toContain("The output changed.")
    expect(text).toContain("deployed")
    await fs.rm(path.join(dir, "state.txt"))
    const failed = await Effect.runPromise(RoutineWatch.observe(target, dir))
    expect(failed.state).not.toBe("exit 0")
    expect(RoutineWatch.describe(target, changed.fingerprint, failed)).toContain("exit: 0 ->")
  })
})
