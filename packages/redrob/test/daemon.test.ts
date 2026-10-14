/**
 * The shared daemon's record and the attached-apps registry. The process-level behaviour (start,
 * attach over HTTP, idle exit) was driven by hand against a dev daemon; these pin the pure parts
 * so a change to the record shape or the idle accounting fails here first.
 */
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Daemon } from "@/daemon/connect"
import * as Registry from "@/daemon/registry"
import * as Clients from "@redrob-code/server/clients"

const dirs: string[] = []
async function runDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "redrob-run-"))
  dirs.push(dir)
  return { REDROB_RUN_DIR: dir } as NodeJS.ProcessEnv
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

const record = (over: Partial<Registry.Record> = {}): Registry.Record => ({
  id: "id-1",
  version: "0.0.0",
  url: "http://127.0.0.1:4096",
  port: 4096,
  pid: process.pid,
  secret: "s3cret",
  ...over,
})

describe("daemon registry", () => {
  test("writes the record with mode 0600 and reads it back", async () => {
    const env = await runDir()
    await Registry.write(record(), env)
    // POSIX mode bits only: Windows reports 0666 for everything and protects the file by ACL.
    if (process.platform !== "win32") {
      const stat = await fs.stat(Registry.file(env))
      expect(stat.mode & 0o777).toBe(0o600)
    }
    expect(await Registry.read(env)).toEqual(record())
  })

  test("a record that does not parse, or lacks a field, reads as absent", async () => {
    const env = await runDir()
    await fs.mkdir(Registry.directory(env), { recursive: true })
    await fs.writeFile(Registry.file(env), "{not json")
    expect(await Registry.read(env)).toBeUndefined()
    await fs.writeFile(Registry.file(env), JSON.stringify({ url: "x", pid: 1 }))
    expect(await Registry.read(env)).toBeUndefined()
  })

  test("remove leaves a newer daemon's record alone", async () => {
    const env = await runDir()
    await Registry.write(record({ id: "newer" }), env)
    await Registry.remove("older", env)
    expect((await Registry.read(env))?.id).toBe("newer")
    await Registry.remove("newer", env)
    expect(await Registry.read(env)).toBeUndefined()
  })

  test("alive tells a live pid from a dead one", () => {
    expect(Registry.alive(process.pid)).toBe(true)
    expect(Registry.alive(2 ** 22 - 1)).toBe(false)
  })

  test("the Basic header carries the daemon's username and secret", () => {
    const header = Registry.headers("abc").Authorization
    expect(header.startsWith("Basic ")).toBe(true)
    expect(Buffer.from(header.slice(6), "base64").toString()).toBe("redrob:abc")
  })

  test("healthy is false for a daemon that does not answer, and true for one that does", async () => {
    const no = await Registry.healthy(record({ url: "http://127.0.0.1:9" }), undefined, 300)
    expect(no).toBe(false)
    const yes = await Registry.healthy(record(), (async () =>
      Response.json({ healthy: true })) as unknown as typeof fetch)
    expect(yes).toBe(true)
    const wrong = await Registry.healthy(
      record(),
      (async () => new Response("", { status: 401 })) as unknown as typeof fetch,
    )
    expect(wrong).toBe(false)
  })
})

describe("attached apps", () => {
  test("idle accounting: idle from start, not idle while attached, idle again when the last leaves", () => {
    Clients.reset(1_000)
    expect(Clients.idleFor(4_000)).toBe(3_000)
    const a = Clients.attach({ app: "cowork" }, 5_000)
    const b = Clients.attach({ app: "design", pid: 7 }, 6_000)
    expect(Clients.idleFor(7_000)).toBeUndefined()
    expect(Clients.list().map((c) => c.app)).toEqual(["cowork", "design"])
    expect(Clients.detach(a.id, 8_000)).toBe(true)
    expect(Clients.idleFor(9_000)).toBeUndefined()
    expect(Clients.detach(b.id, 10_000)).toBe(true)
    expect(Clients.idleFor(12_500)).toBe(2_500)
    expect(Clients.detach(b.id)).toBe(false)
  })

  test("requests count as activity: not idle while one is in flight, idle timer restarts after it", () => {
    Clients.reset(1_000)
    expect(Clients.idleFor(4_000)).toBe(3_000)
    Clients.requestStarted(5_000)
    expect(Clients.idleFor(600_000)).toBeUndefined()
    Clients.requestEnded(20_000)
    expect(Clients.idleFor(25_000)).toBe(5_000)
    // Two overlapping requests: idle only once both are answered.
    Clients.requestStarted(30_000)
    Clients.requestStarted(31_000)
    Clients.requestEnded(32_000)
    expect(Clients.idleFor(40_000)).toBeUndefined()
    Clients.requestEnded(33_000)
    expect(Clients.idleFor(40_000)).toBe(7_000)
    // An attachment still wins over the request clock.
    const a = Clients.attach({ app: "office" }, 41_000)
    expect(Clients.idleFor(90_000)).toBeUndefined()
    Clients.detach(a.id, 50_000)
    expect(Clients.idleFor(60_000)).toBe(10_000)
  })

  test("status polls are not activity; everything else is", () => {
    expect(Clients.countsAsActivity("/api/health")).toBe(false)
    expect(Clients.countsAsActivity("/api/clients")).toBe(false)
    expect(Clients.countsAsActivity("/api/clients/abc")).toBe(false)
    expect(Clients.countsAsActivity("/v1/chat/completions")).toBe(true)
    expect(Clients.countsAsActivity("/provider")).toBe(true)
    expect(Clients.countsAsActivity("/api/healthz")).toBe(true)
  })

  test("an app whose heartbeats stop is swept; a heartbeat keeps one alive", () => {
    Clients.reset(0)
    const live = Clients.attach({ app: "office" }, 0)
    const dead = Clients.attach({ app: "crashed" }, 0)
    Clients.heartbeat(live.id, Clients.TTL_MS)
    expect(Clients.sweep(Clients.TTL_MS + 1)).toBe(1)
    expect(Clients.list().map((c) => c.id)).toEqual([live.id])
    expect(Clients.heartbeat(dead.id)).toBeUndefined()
    expect(Clients.sweep(2 * Clients.TTL_MS + 2)).toBe(1)
    expect(Clients.idleFor(2 * Clients.TTL_MS + 2)).toBe(0)
  })

  test("an app name is trimmed, bounded and never empty", () => {
    Clients.reset()
    expect(Clients.attach({ app: "   " }).app).toBe("unknown")
    expect(Clients.attach({ app: " x".repeat(80) }).app.length).toBe(64)
  })
})

describe("attach", () => {
  test("posts the app, heartbeats, re-attaches after a 404 and deletes on detach", async () => {
    const calls: string[] = []
    let ids = 0
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      calls.push(`${method} ${new URL(url).pathname}`)
      if (method === "POST" && url.endsWith("/api/clients")) {
        expect(JSON.parse(String(init?.body)).app).toBe("cut")
        return Response.json({ id: `c${++ids}` })
      }
      if (method === "GET") return Response.json({ clients: [], ttlMs: 15_000 })
      if (url.endsWith("/heartbeat")) return new Response("", { status: ids === 1 ? 404 : 200 })
      return new Response("", { status: 204 })
    }) as unknown as typeof fetch
    const connection = { url: "http://127.0.0.1:4096/", headers: Registry.headers("s"), record: record() }
    const a = await Daemon.attach(connection, "cut", { pid: 7, fetch: fetchImpl })
    expect(a.id).toBe("c1")
    await new Promise((r) => setTimeout(r, 5_300))
    // The first heartbeat met a 404 (daemon restarted), so the attachment was re-created.
    expect(a.id).toBe("c2")
    await a.detach()
    await a.detach()
    expect(calls).toEqual([
      "POST /api/clients",
      "GET /api/clients",
      "POST /api/clients/c1/heartbeat",
      "POST /api/clients",
      "DELETE /api/clients/c2",
    ])
  }, 10_000)
})

describe("directory config", () => {
  test("the SDK computes the same per-directory config dir as the engine", async () => {
    const { ConfigPaths } = await import("@/config/paths")
    const { Global } = await import("@redrob-code/core/global")
    const sdk = await import("@redrob-labs/sdk/daemon")
    const dir = path.join(os.tmpdir(), "redrob-dircfg", "Project")
    expect(sdk.directoryKey(dir)).toBe(ConfigPaths.directoryKey(dir))
    expect(sdk.directoryKey(dir + path.sep)).toBe(sdk.directoryKey(dir))
    expect(sdk.directoryConfigDir(dir, { XDG_STATE_HOME: path.dirname(Global.Path.state) })).toBe(
      ConfigPaths.directoryConfigDir(dir),
    )
  })
})
