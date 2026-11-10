import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { PhotonImage } from "@silvia-odwyer/photon-node"
import { RunnerBrowser } from "../../src/browser"
import type { BusEvent, DaemonApi } from "../../src/desk/daemon"
import { Forwarder, match, refusal } from "../../src/desk/forward"

const PAGE = `<!doctype html><html><head><title>Login test</title></head><body style="margin:0;background:#fff">
<h1 id="h">Hello</h1>
<button onclick="document.getElementById('h').textContent='Clicked'">Press me</button>
<a href="/next">Next page</a>
<input id="email" placeholder="Email" style="position:absolute;left:40px;top:300px;width:300px;height:40px">
<input id="pw" type="password" value="hunter2"
  style="position:absolute;left:40px;top:400px;width:400px;height:60px;background:#f00;color:#000;border:0">
<input type="password" placeholder="Repeat it" value="hunter3: again" style="position:absolute;left:40px;top:520px">
</body></html>`

const hasChromium = await RunnerBrowser.available()
let server: ReturnType<typeof Bun.serve> | undefined
let base = ""

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/next"
        ? new Response("<title>Next</title><p>Second page</p>", { headers: { "content-type": "text/html" } })
        : new Response(PAGE, { headers: { "content-type": "text/html" } }),
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(async () => {
  await RunnerBrowser.close()
  server?.stop(true)
})

describe("desk browser routes", () => {
  test("are on the allowlist with their body rules", () => {
    expect(match({ method: "GET", path: "/desk/browser" })?.route.screen).toBe("status")
    expect(match({ method: "POST", path: "/desk/browser/watch", body: { on: true } })?.route.readOnly).toBe(true)
    expect(match({ method: "POST", path: "/desk/browser/ack", body: { seq: 3 } })?.route.readOnly).toBe(true)
    expect(match({ method: "POST", path: "/desk/browser/control", body: { owner: "user" } })?.route.readOnly).toBe(
      undefined,
    )
    const click = { kind: "mouse", type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 }
    expect(match({ method: "POST", path: "/desk/browser/input", body: click })?.route.screen).toBe("input")
    // A bad body is a 400, an unknown browser path a 403.
    const bad = { method: "POST", path: "/desk/browser/control", body: { owner: "root" } } as const
    expect(match(bad)).toBeUndefined()
    expect(refusal(bad)).toBe(400)
    expect(match({ method: "POST", path: "/desk/browser/eval", body: {} })).toBeUndefined()
    expect(refusal({ method: "POST", path: "/desk/browser/eval", body: {} })).toBe(403)
  })

  test("password values in a reading become their length", () => {
    const tree = [
      '- textbox "Password" [ref=e7]: hunter2',
      '- textbox "Pin" [ref=e8]:',
      '  - text: "a: b"',
      "- text: hunter2x",
    ]
    expect(RunnerBrowser.hidePasswords(tree.join("\n"), ["hunter2", "a: b"]).split("\n")).toEqual([
      '- textbox "Password" [ref=e7]: [password, 7 characters]',
      '- textbox "Pin" [ref=e8]:',
      "  - text: [password, 4 characters]",
      "- text: hunter2x",
    ])
  })

  test("input bodies are checked field by field", () => {
    expect(RunnerBrowser.parseInput({ kind: "text", text: "안녕하세요" })).toEqual({ kind: "text", text: "안녕하세요" })
    expect(RunnerBrowser.parseInput({ kind: "key", type: "keyDown", key: "Enter", evil: 1 })).toEqual({
      kind: "key",
      type: "keyDown",
      key: "Enter",
    })
    expect(RunnerBrowser.parseInput({ kind: "scroll", x: 1, y: 2, deltaY: 300 })).toMatchObject({ deltaY: 300 })
    expect(RunnerBrowser.parseInput({ kind: "mouse", type: "mouseWheel", x: 1, y: 2 })).toBeUndefined()
    expect(RunnerBrowser.parseInput({ kind: "mouse", type: "mousePressed", x: "1", y: 2 })).toBeUndefined()
    expect(RunnerBrowser.parseInput({ kind: "text", text: "" })).toBeUndefined()
    expect(RunnerBrowser.parseInput({ kind: "key", type: "keyDown", text: "x".repeat(9) })).toBeUndefined()
    expect(RunnerBrowser.parseInput({ kind: "eval", expression: "1" })).toBeUndefined()
  })
})

/** A forwarder with one link; the link's messages land in `sent`. */
function desk() {
  const daemon = {
    raw: async () => ({ status: 200, body: {} }),
    events: async (_listener: (event: BusEvent) => void, signal: AbortSignal) =>
      new Promise((resolve) => signal.addEventListener("abort", resolve)),
  } as unknown as DaemonApi
  const forwarder = new Forwarder(
    daemon,
    async () => undefined,
    () => undefined,
  )
  const sent: Record<string, unknown>[] = []
  const link = forwarder.link(async (message) => void sent.push(message))
  let id = 0
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const mine = ++id
    await forwarder.handle(link, { t: "req", id: mine, method, path, ...(body !== undefined ? { body } : {}) })
    return sent.find((message) => message.t === "res" && message.id === mine) as { status: number; body?: any }
  }
  const frames = () => sent.filter((message) => message.type === "browser.frame") as unknown as RunnerBrowser.Frame[]
  return { forwarder, link, sent, call, frames }
}

async function until<T>(read: () => T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(25)
  }
}

/** The RGB of the decoded JPEG at a CSS point of the 1280-wide viewport. */
function pixel(frame: RunnerBrowser.Frame, x: number, y: number): [number, number, number] {
  const image = PhotonImage.new_from_byteslice(Buffer.from(frame.jpegBase64, "base64"))
  const scale = image.get_width() / frame.width
  const at = (Math.round(y * scale) * image.get_width() + Math.round(x * scale)) * 4
  const raw = image.get_raw_pixels()
  image.free()
  return [raw[at]!, raw[at + 1]!, raw[at + 2]!]
}

describe.skipIf(!hasChromium)("runner browser", () => {
  test("reads numbered elements, clicks by number, and asks for a new reading after a navigation", async () => {
    const first = await RunnerBrowser.open(base)
    expect(first.title).toBe("Login test")
    // The agent never reads what a password field holds, only how long it is.
    expect(first.text).not.toContain("hunter2")
    expect(first.text).not.toContain("hunter3")
    expect(first.text).toContain("[password, 7 characters]")
    expect(first.text).toContain("[password, 14 characters]")
    const button = first.text.match(/button "Press me" \[ref=(\w+)\]/)?.[1]
    expect(button).toBeDefined()
    const after = await RunnerBrowser.click(button!)
    expect(after.text).toContain("Clicked")

    const link = after.text.match(/link "Next page" \[ref=(\w+)\]/)?.[1]
    const next = await RunnerBrowser.click(link!)
    expect(next.title).toBe("Next")
    expect((await RunnerBrowser.status()).open).toBe(true)
  })

  test("a number read before the page changed is refused until the agent reads again", async () => {
    const reading = await RunnerBrowser.open(base)
    const email = reading.text.match(/textbox "Email" \[ref=(\w+)\]/)?.[1]
    const shot = await RunnerBrowser.screenshot()
    expect(shot.url).toContain("127.0.0.1")
    // A takeover in between: the numbers from before it are refused.
    await RunnerBrowser.control("user")
    await RunnerBrowser.control("agent")
    await RunnerBrowser.turn()
    await expect(RunnerBrowser.type(email!, "x")).rejects.toThrow("read the page again")
    const fresh = await RunnerBrowser.read()
    const again = fresh.text.match(/textbox "Email" \[ref=(\w+)\]/)?.[1]
    const typed = await RunnerBrowser.type(again!, "me@example.com")
    expect(typed.text).toContain("me@example.com")
  })

  test("frames go out one at a time, each after the last ack, with the password field painted over", async () => {
    await RunnerBrowser.open(base)
    const { call, frames, forwarder, link } = desk()
    expect((await call("GET", "/desk/capabilities")).body.features).toContain("browser")
    expect((await call("POST", "/desk/browser/watch", { on: true })).status).toBe(200)
    const first = await until(() => frames()[0])
    expect(first).toMatchObject({ source: "runner", width: 1280, height: 800 })
    expect(first.seq).toBeGreaterThan(0)

    // The password field (red, at 40,400 400x60) is gray in the picture; the page around it is not.
    const [r, g, b] = pixel(first, 240, 430)
    expect(Math.abs(r - 96) + Math.abs(g - 96) + Math.abs(b - 96)).toBeLessThan(40)
    expect(pixel(first, 600, 600)[0]).toBeGreaterThan(200)

    // The page changes, but without an ack no new frame is sent.
    const reading = await RunnerBrowser.read()
    await RunnerBrowser.click(reading.text.match(/button "Press me" \[ref=(\w+)\]/)![1]!)
    await Bun.sleep(700)
    expect(frames().length).toBe(1)
    await call("POST", "/desk/browser/ack", { seq: first.seq })
    const second = await until(() => frames()[1])
    expect(second.seq).toBeGreaterThan(first.seq)

    await call("POST", "/desk/browser/watch", { on: false })
    forwarder.unlink(link)
  })

  test("takeover: the agent waits, the user's input goes in, and the agent gets one line of what they did", async () => {
    await RunnerBrowser.open(base)
    const { call, sent } = desk()
    await call("POST", "/desk/browser/watch", { on: true })
    // Input while the agent holds it is refused.
    expect((await call("POST", "/desk/browser/input", { kind: "text", text: "x" })).status).toBe(409)

    expect((await call("POST", "/desk/browser/control", { owner: "user" })).body).toEqual({ owner: "user" })
    expect(sent.some((message) => message.type === "browser.control" && message.owner === "user")).toBe(true)
    const result: { line: string | undefined | null } = { line: null }
    const agent = RunnerBrowser.turn().then((line) => (result.line = line))

    const press = { kind: "mouse", x: 200, y: 430, button: "left", clickCount: 1 }
    await call("POST", "/desk/browser/input", { ...press, type: "mousePressed" })
    await call("POST", "/desk/browser/input", { ...press, type: "mouseReleased" })
    await call("POST", "/desk/browser/input", { kind: "key", type: "keyDown", key: "End", code: "End" })
    await call("POST", "/desk/browser/input", { kind: "text", text: "s3cret" })
    await call("POST", "/desk/browser/input", { kind: "key", type: "rawKeyDown", key: "Enter", code: "Enter" })
    await call("POST", "/desk/browser/input", { kind: "scroll", x: 600, y: 300, deltaY: 200 })
    await Bun.sleep(100)
    expect(result.line).toBeNull()

    await call("POST", "/desk/browser/control", { owner: "agent" })
    await agent
    expect(result.line).toContain("The user had the browser and handed it back.")
    expect(result.line).toContain("typed 6 characters into a password field")
    expect(result.line).not.toContain("s3cret")
    expect(result.line).toContain("pressed Enter")
    expect(result.line).toContain("scrolled")
    // Said once: the next action gets nothing extra.
    expect(await RunnerBrowser.turn()).toBeUndefined()
  })

  test("the agent stops waiting after the limit", async () => {
    await RunnerBrowser.control("user")
    await expect(RunnerBrowser.turn(undefined, 50)).rejects.toThrow("has not handed it back")
    await RunnerBrowser.control("agent")
    await RunnerBrowser.turn()
  })
})
