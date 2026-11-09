import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { BusEvent, DaemonApi } from "../../src/desk/daemon"
import { FEATURES, Forwarder } from "../../src/desk/forward"
import { updateMachine } from "../../src/desk/settings"
import { SessionSkills } from "../../src/desk/skills"
import { sha256 } from "../../src/desk/write"

// The desk keeps its settings and skill manifest under the test home (REDROB_TEST_HOME, preload).
const made: string[] = []
let work = ""

const tempDir = async () => {
  const dir = await realpath(await Bun.$`mktemp -d`.text().then((text) => text.trim()))
  made.push(dir)
  return dir
}

beforeAll(() => {
  if (!process.env.REDROB_TEST_HOME) throw new Error("needs the test preload")
  process.env.REDROB_DESK_REPOS = path.join(process.env.REDROB_TEST_HOME, "repos")
})

afterAll(async () => {
  delete process.env.REDROB_DESK_REPOS
  await updateMachine({ access: "trusted" })
  for (const dir of made) await rm(dir, { recursive: true, force: true })
})

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const code = await child.exited
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(child.stderr).text()}`)
  return (await new Response(child.stdout).text()).trim()
}

type Call = { method: string; path: string; body?: unknown }

/** A daemon with sessions in `folders`, recording what reaches it. */
function setup(folders: () => string[], socket?: (path: string) => WebSocket) {
  const calls: Call[] = []
  let emit: (event: BusEvent) => void = () => undefined
  const daemon = {
    raw: async (method: string, requestPath: string, body?: unknown) => {
      calls.push({ method, path: requestPath, ...(body !== undefined ? { body } : {}) })
      const url = new URL(requestPath, "http://daemon")
      if (method === "GET" && url.pathname === "/api/session") {
        const directory = url.searchParams.get("directory")
        return { status: 200, body: { data: directory && folders().includes(directory) ? [{ id: "ses_1" }] : [] } }
      }
      if (method === "POST" && url.pathname === "/api/session") {
        const value = body as { id?: string; location?: { directory?: string } }
        return { status: 200, body: { data: { id: value.id ?? "ses_new", location: value.location } } }
      }
      if (url.pathname === "/api/model") return { status: 200, body: { data: [] } }
      if (url.pathname === "/api/session/active") return { status: 200, body: { data: {} } }
      return { status: 200, body: { ok: true } }
    },
    events: async (listener: (event: BusEvent) => void, signal: AbortSignal) => {
      emit = listener
      await new Promise((resolve) => signal.addEventListener("abort", resolve))
    },
    socket: socket ?? (() => new WebSocket("ws://127.0.0.1:1")),
  } as unknown as DaemonApi
  const forwarder = new Forwarder(daemon, async () => undefined, () => undefined)
  forwarder.start()
  const sent: Record<string, unknown>[] = []
  const link = forwarder.link(async (message) => void sent.push(message))
  let next = 1
  const req = async (method: string, requestPath: string, body?: unknown, headers?: Record<string, string>) => {
    const id = next++
    await forwarder.handle(link, { t: "req", id, method, path: requestPath, ...(body !== undefined ? { body } : {}), ...(headers ? { headers } : {}) })
    return sent.findLast((message) => message.t === "res" && message.id === id) as {
      status: number
      body?: any
      headers?: Record<string, string>
    }
  }
  return { forwarder, link, calls, sent, req, emit: (event: BusEvent) => emit(event) }
}

beforeEach(async () => {
  work = await tempDir()
  await updateMachine({ access: "trusted" })
})

const q = (params: Record<string, string>) => `?${new URLSearchParams(params)}`

describe("desk code work routes", () => {
  test("capabilities list the code-work features", async () => {
    const { req, forwarder } = setup(() => [])
    const res = await req("GET", "/desk/capabilities")
    forwarder.stop()
    expect(res.status).toBe(200)
    // `browser` follows when this machine has a Chromium the runner browser can start.
    expect(res.body.features.slice(0, FEATURES.length)).toEqual([...FEATURES])
    expect([...FEATURES]).toEqual([
      "files",
      "files.write",
      "pty",
      "commands",
      "worktree",
      "skills.push",
      "routine",
      "snapshot",
    ])
  })

  test("file, find and command routes pass only for a session's work folder", async () => {
    const { req, calls, forwarder } = setup(() => [work])
    const ok = await req("GET", `/file${q({ directory: work, path: "." })}`)
    expect(ok.status).toBe(200)
    expect(calls.at(-1)).toEqual({ method: "GET", path: `/file${q({ directory: work, path: "." })}` })
    for (const route of ["/file/content", "/file/status", "/find", "/find/file", "/find/symbol", "/command"])
      expect((await req("GET", `${route}${q({ directory: work, path: "a" })}`)).status).toBe(200)

    const before = calls.length
    // Not a work folder, no folder, two folders, another workspace.
    expect((await req("GET", `/file${q({ directory: os.tmpdir(), path: "." })}`)).status).toBe(403)
    expect((await req("GET", `/file${q({ path: "." })}`)).status).toBe(403)
    expect((await req("GET", `/file?directory=${work}&directory=/etc&path=.`)).status).toBe(403)
    expect((await req("GET", `/file${q({ directory: work, workspace: "wrk_1", path: "." })}`)).status).toBe(403)
    // A route outside the list.
    expect((await req("GET", `/file/other${q({ directory: work })}`)).status).toBe(403)
    expect(calls.slice(before).filter((call) => !call.path.startsWith("/api/session?"))).toEqual([])
    forwarder.stop()
  })

  test("terminal routes: in the work folder only, and never on a read-only machine", async () => {
    const { req, calls, forwarder } = setup(() => [work])
    await mkdir(path.join(work, "src"))
    expect((await req("POST", `/pty${q({ directory: work })}`, { cwd: path.join(work, "src"), title: "t" })).status).toBe(
      200,
    )
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: `/pty${q({ directory: work })}` })
    expect((await req("POST", `/pty${q({ directory: work })}`, { cwd: "/etc" })).status).toBe(403)
    expect((await req("POST", `/pty${q({ directory: work })}`, { env: { LD_PRELOAD: "x" } })).status).toBe(400)
    expect((await req("PUT", `/pty/pty_1${q({ directory: work })}`, { size: { rows: 30, cols: 100 } })).status).toBe(200)
    expect((await req("DELETE", `/pty/pty_1${q({ directory: work })}`)).status).toBe(200)
    expect(calls.at(-1)).toEqual({ method: "DELETE", path: `/pty/pty_1${q({ directory: work })}` })

    await updateMachine({ access: "read_only" })
    expect((await req("GET", `/pty${q({ directory: work })}`)).status).toBe(403)
    expect((await req("GET", `/pty/shells${q({ directory: work })}`)).status).toBe(403)
    // Reading files is still fine; editing is not.
    expect((await req("GET", `/file${q({ directory: work, path: "." })}`)).status).toBe(200)
    const write = await req("POST", "/desk/file/write", { directory: work, path: "a.txt", content: "x" })
    expect(write.status).toBe(403)
    expect(write.headers).toEqual({ "X-Redrob-Machine-Access": "read_only" })
    forwarder.stop()
  })

  test("the editor writes inside the work folder, with a hash check", async () => {
    const { req, forwarder } = setup(() => [work])
    await writeFile(path.join(work, "auth.ts"), "export const a = 1\n")

    const read = await req("GET", `/desk/file/content${q({ directory: work, path: "auth.ts" })}`)
    expect(read.status).toBe(200)
    // Not trimmed, so a save keeps the last newline.
    expect(read.body).toEqual({ type: "text", content: "export const a = 1\n", hash: sha256(Buffer.from("export const a = 1\n")) })

    const saved = await req("POST", "/desk/file/write", {
      directory: work,
      path: "auth.ts",
      content: "export const a = 2\n",
      baseHash: read.body.hash,
    })
    expect(saved).toMatchObject({ status: 200, body: { hash: sha256(Buffer.from("export const a = 2\n")) } })

    // The agent changed it after the panel opened it: 409 with the file's hash, and nothing written.
    await writeFile(path.join(work, "auth.ts"), "agent\n")
    const stale = await req("POST", "/desk/file/write", {
      directory: work,
      path: "auth.ts",
      content: "mine\n",
      baseHash: saved.body.hash,
    })
    expect(stale).toMatchObject({ status: 409, body: { hash: sha256(Buffer.from("agent\n")) } })
    expect(await readFile(path.join(work, "auth.ts"), "utf8")).toBe("agent\n")
    // "Save mine anyway": no baseHash.
    expect((await req("POST", "/desk/file/write", { directory: work, path: "auth.ts", content: "mine\n" })).status).toBe(200)
    // An absolute path inside the folder finds its folder.
    expect((await req("POST", "/desk/file/write", { path: path.join(work, "new", "b.ts"), content: "b" })).status).toBe(200)
    expect(await readFile(path.join(work, "new", "b.ts"), "utf8")).toBe("b")

    const renamed = await req("POST", "/desk/file/rename", { directory: work, from: "new/b.ts", to: "new/c.ts" })
    expect(renamed.status).toBe(200)
    expect((await req("POST", "/desk/file/rename", { directory: work, from: "auth.ts", to: "new/c.ts" })).status).toBe(409)
    expect((await req("POST", "/desk/file/delete", { directory: work, path: "new" })).status).toBe(200)
    expect(await stat(path.join(work, "new")).catch(() => undefined)).toBeUndefined()
    forwarder.stop()
  })

  test("the editor never leaves the work folder", async () => {
    const { req, forwarder } = setup(() => [work])
    const outside = await tempDir()
    await symlink(outside, path.join(work, "link"))
    await mkdir(path.join(work, ".git"))
    for (const body of [
      { directory: work, path: "../escape.txt", content: "x" },
      { directory: work, path: "link/escape.txt", content: "x" },
      { directory: work, path: ".git/config", content: "x" },
      { directory: outside, path: "a.txt", content: "x" },
      { path: path.join(outside, "a.txt"), content: "x" },
    ])
      expect((await req("POST", "/desk/file/write", body)).status).toBe(403)
    expect((await req("POST", "/desk/file/delete", { directory: work, path: "." })).status).toBe(403)
    expect((await req("POST", "/desk/file/rename", { directory: work, from: "link", to: "../moved" })).status).toBe(403)
    expect(await stat(path.join(outside, "escape.txt")).catch(() => undefined)).toBeUndefined()
    await rm(outside, { recursive: true, force: true })
    forwarder.stop()
  })

  test("session create with a branch runs in <repo>-wt-<branch end>", async () => {
    const repo = path.join(work, "app")
    await mkdir(repo)
    await git(repo, "init", "-q", "-b", "main")
    await git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
    const { req, calls, forwarder } = setup(() => [])

    const created = await req("POST", "/api/session", { location: { directory: repo }, branch: "fix/login-401" })
    const worktree = path.join(work, "app-wt-login-401")
    expect(created.status).toBe(200)
    expect(created.headers).toMatchObject({ "X-Redrob-Worktree": worktree, "X-Redrob-Branch": "fix/login-401" })
    expect(calls.findLast((call) => call.method === "POST" && call.path === "/api/session")?.body).toEqual({ location: { directory: worktree } })
    expect(await git(worktree, "branch", "--show-current")).toBe("fix/login-401")
    // The new worktree is a work folder at once.
    expect((await req("GET", `/file${q({ directory: worktree, path: "." })}`)).status).toBe(200)

    // The next message of the chat continues there.
    const again = await req("POST", "/api/session", { location: { directory: repo }, branch: "fix/login-401" })
    expect(again.headers?.["X-Redrob-Worktree"]).toBe(worktree)
    // A bad branch name or a repo that is not a path or owner/name is refused before anything runs.
    expect((await req("POST", "/api/session", { location: { directory: repo }, branch: "-x" })).status).toBe(400)
    expect((await req("POST", "/api/session", { branch: "a", repo: "not a repo" })).status).toBe(400)
    // An old app's create is passed on unchanged.
    expect((await req("POST", "/api/session", { location: { directory: repo } })).status).toBe(200)
    expect(calls.findLast((call) => call.method === "POST" && call.path === "/api/session")?.body).toEqual({ location: { directory: repo } })
    forwarder.stop()
  })

  test("session skills go to the session's own folder, once per content hash, and leave with the session", async () => {
    const { req, calls, forwarder, emit } = setup(() => [work])
    const sha = "a".repeat(64)
    const skill = {
      name: "review-pr",
      scope: "user",
      contentSha256: sha,
      files: [
        { path: "SKILL.md", content: "---\nname: review-pr\ndescription: Review a PR\n---\nReview it." },
        { path: "scripts/run.sh", content: "echo hi" },
      ],
    }
    const created = await req("POST", "/api/session", { location: { directory: work }, skills: [skill] })
    expect(created.status).toBe(200)
    expect(created.headers?.["X-Redrob-Skills"]).toBe("1")
    const body = calls.findLast((call) => call.method === "POST" && call.path === "/api/session")?.body as { id: string; skills?: unknown }
    expect(body.skills).toBeUndefined()
    expect(body.id).toStartWith("ses_")
    const folder = SessionSkills.folder(work, body.id)
    expect(await readFile(path.join(folder, "user-review-pr", "SKILL.md"), "utf8")).toContain("Review it.")
    expect(await readFile(path.join(folder, "user-review-pr", "scripts", "run.sh"), "utf8")).toBe("echo hi")
    // Nothing in the repository.
    expect(await stat(path.join(work, ".redrob")).catch(() => undefined)).toBeUndefined()

    // The same content again needs no files; an unknown one without files is refused first.
    expect((await req("GET", "/desk/skills")).body).toEqual({ v: 1, skills: [{ contentSha256: sha }] })
    const second = await req("POST", "/api/session", {
      id: "ses_second",
      location: { directory: work },
      skills: [{ name: "review-pr", scope: "user", contentSha256: sha }],
    })
    expect(second.status).toBe(200)
    expect(await stat(path.join(SessionSkills.folder(work, "ses_second"), "user-review-pr", "SKILL.md"))).toBeTruthy()
    const missing = await req("POST", "/api/session", {
      location: { directory: work },
      skills: [{ name: "other", scope: "org", contentSha256: "b".repeat(64) }],
    })
    expect(missing).toMatchObject({ status: 409, body: { missingSkills: ["b".repeat(64)] } })
    expect(
      (await req("POST", "/api/session", { location: { directory: work }, skills: [{ ...skill, files: [{ path: "../x", content: "" }] }] }))
        .status,
    ).toBe(400)

    emit({ type: "session.deleted", data: { sessionID: body.id } })
    await Bun.sleep(50)
    expect(await stat(folder).catch(() => undefined)).toBeUndefined()
    forwarder.stop()
  })

  test("file watcher events reach the devices working in that folder", async () => {
    const { req, forwarder, sent, emit } = setup(() => [work])
    const other = setup(() => [work])
    await req("GET", `/file${q({ directory: work, path: "." })}`)
    emit({ type: "file.watcher.updated", data: { file: path.join(work, "src", "a.ts"), event: "change" } })
    emit({ type: "file.watcher.updated", data: { file: "/elsewhere/b.ts", event: "change" } })
    await Bun.sleep(150)
    const events = sent.flatMap((frame) => (frame.t === "evts" ? (frame.events as BusEvent[]) : []))
    expect(events).toEqual([{ type: "file.watcher.updated", data: { file: path.join(work, "src", "a.ts"), event: "change" } }])
    // A device that never opened the folder gets none.
    other.emit({ type: "file.watcher.updated", data: { file: path.join(work, "src", "a.ts"), event: "change" } })
    await Bun.sleep(150)
    expect(other.sent.filter((frame) => frame.t === "evts")).toEqual([])
    forwarder.stop()
    other.forwarder.stop()
  })

  test("a terminal websocket rides relay stream messages", async () => {
    const received: string[] = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, server) {
        return server.upgrade(request) ? undefined : new Response("no", { status: 400 })
      },
      websocket: {
        open(ws) {
          ws.send("$ ")
          ws.send(new Uint8Array([0, ...new TextEncoder().encode('{"cursor":2}')]))
        },
        message(ws, message) {
          received.push(String(message))
          ws.send(`echo:${message}`)
          if (String(message) === "exit\n") ws.close(1000)
        },
      },
    })
    const { forwarder, link, sent } = setup(
      () => [work],
      (requestPath) => new WebSocket(`ws://127.0.0.1:${server.port}${requestPath}`),
    )
    const streamPath = `/pty/pty_1/connect${q({ directory: work, cursor: "0" })}`
    await forwarder.handle(link, { t: "stream", op: "open", sid: 7, path: streamPath })
    await forwarder.handle(link, { t: "stream", op: "data", sid: 7, data: "ls\n" })
    await Bun.sleep(80)
    await forwarder.handle(link, { t: "stream", op: "data", sid: 7, data: "exit\n" })
    await Bun.sleep(80)
    const frames = sent.filter((message) => message.t === "stream")
    expect(frames[0]).toEqual({ t: "stream", op: "open", sid: 7, status: 200 })
    const text = frames.flatMap((frame) => (typeof frame.data === "string" ? [frame.data] : [])).join("")
    expect(text).toBe("$ echo:ls\necho:exit\n")
    expect(frames.find((frame) => frame.b64)?.b64).toBe(Buffer.from([0, ...new TextEncoder().encode('{"cursor":2}')]).toString("base64"))
    expect(frames.at(-1)).toEqual({ t: "stream", op: "close", sid: 7, code: 1000 })
    expect(received).toEqual(["ls\n", "exit\n"])

    // Not a work folder, another route, extra query, a read-only machine: refused, nothing opened.
    for (const [sid, open] of [
      [8, `/pty/pty_1/connect${q({ directory: os.tmpdir() })}`],
      [9, `/api/event${q({ directory: work })}`],
      [10, `/pty/pty_1/connect${q({ directory: work, ticket: "x" })}`],
    ] as const) {
      await forwarder.handle(link, { t: "stream", op: "open", sid, path: open })
      expect(sent.findLast((message) => message.t === "stream" && message.sid === sid)).toEqual({ t: "stream", op: "open", sid, status: 403 })
    }
    await updateMachine({ access: "read_only" })
    await forwarder.handle(link, { t: "stream", op: "open", sid: 11, path: streamPath })
    expect(sent.at(-1)).toEqual({ t: "stream", op: "open", sid: 11, status: 403 })
    forwarder.stop()
    server.stop(true)
  })
})

