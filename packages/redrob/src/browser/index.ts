/**
 * The runner's own browser (code-work design 10.3): one headless Chromium per process. The agent's
 * `browser` tool drives it; a paired device watches it and can take it over through the desk
 * (`desk/screen.ts`).
 *
 * - Reading: Playwright's accessibility snapshot in `ai` mode numbers elements (`[ref=e5]`). A
 *   number belongs to the page it was read from: after a navigation or a takeover the agent must
 *   read again (`StaleError`). Every agent action ends with a fresh read.
 * - Watching: `Page.startScreencast`. Chromium sends the next frame only after the last one is
 *   acked, and it is acked only when a viewer acks it, so a slow link gets fewer frames.
 * - Takeover: while the owner is `user`, the agent's next browser action waits (up to 10 minutes).
 *   The device's mouse and keys go in as CDP `Input.*`. When control comes back, the agent gets one
 *   line saying what the person did; text typed into a password field is kept as a count only.
 * - Passwords: every frame and screenshot has its password fields painted over before it leaves.
 *   If painting fails, the picture is withheld.
 */
import { existsSync, readdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import type { Browser as Chromium, BrowserContext, CDPSession, Page } from "playwright-core"

export type Owner = "agent" | "user"

export const VIEWPORT = { width: 1280, height: 800 } as const
/** How long the agent's next browser action waits for the person to hand the browser back. */
export const TAKEOVER_WAIT_MS = 10 * 60_000
/** A browser nobody used or watched for this long is closed. */
const IDLE_CLOSE_MS = 30 * 60_000
/** A frame no viewer acked in this long is acked anyway, so the screencast cannot stall. */
const ACK_TIMEOUT_MS = 5_000
const MAX_READ_CHARS = 40_000
const MAX_NOTES = 30
const ACTION_TIMEOUT_MS = 10_000

export class StaleError extends Error {
  constructor(reason: string) {
    super(`${reason} Element numbers from earlier readings no longer apply; read the page again.`)
  }
}

export class UnavailableError extends Error {}

/** A device sent input while the agent holds the browser. */
export class NotOwnerError extends Error {}

export type Frame = {
  readonly tabId: number
  readonly jpegBase64: string
  /** The viewport in CSS pixels: `Input.*` coordinates are in this space. */
  readonly width: number
  readonly height: number
  readonly seq: number
}

export type Viewer = {
  frame(frame: Frame): void
  control(owner: Owner): void
}

type Open = {
  readonly browser: Chromium
  readonly context: BrowserContext
  page: Page
  tabId: number
  cdp?: CDPSession
}

let opened: Promise<Open> | undefined
let owner: Owner = "agent"
/** What the person did while holding the browser, newest last. */
let notes: string[] = []
/** The line the agent gets on its next browser action after a takeover. */
let handedBack: string | undefined
let stale: string | undefined
let idle: ReturnType<typeof setTimeout> | undefined
let nextTab = 0
const ownerWaiters = new Set<() => void>()

const viewers = new Map<Viewer, { waiting?: number }>()
let seq = 0
let last: Frame | undefined
let pending: { seq: number; ack: () => void; timer: ReturnType<typeof setTimeout> } | undefined

/** The Chromium this machine has: `REDROB_BROWSER_PATH`, Playwright's own, then any in its cache. */
export async function executable(): Promise<string | undefined> {
  const env = process.env.REDROB_BROWSER_PATH
  if (env && existsSync(env)) return env
  try {
    const { chromium } = await import("playwright-core")
    const own = chromium.executablePath()
    if (own && existsSync(own)) return own
  } catch {
    // No registry entry for this platform; look in the cache below.
  }
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "ms-playwright") : undefined,
  ].filter((root): root is string => !!root && existsSync(root))
  const inside = [
    ["chrome-linux64", "chrome"],
    ["chrome-linux", "chrome"],
    ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ["chrome-win64", "chrome.exe"],
    ["chrome-win", "chrome.exe"],
  ]
  for (const root of roots) {
    const builds = readdirSync(root)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
    for (const build of builds)
      for (const parts of inside) {
        const file = path.join(root, build, ...parts)
        if (existsSync(file)) return file
      }
  }
  return undefined
}

/** Whether a browser can be opened here, for `GET /desk/capabilities`. */
export async function available(): Promise<boolean> {
  return (await executable()) !== undefined
}

async function launch(): Promise<Open> {
  const executablePath = await executable()
  if (!executablePath)
    throw new UnavailableError(
      "No Chromium on this machine. Install one with `npx playwright install chromium` or set REDROB_BROWSER_PATH.",
    )
  const { chromium } = await import("playwright-core")
  const browser = await chromium.launch({ executablePath, headless: true })
  const context = await browser.newContext({ viewport: VIEWPORT })
  const state: Open = { browser, context, page: await context.newPage(), tabId: ++nextTab }
  follow(state, state.page)
  // A page the site opens (target=_blank, window.open) becomes the one shown and driven.
  context.on("page", (page) => {
    state.page = page
    state.tabId = ++nextTab
    follow(state, page)
    stale = "A new tab opened."
    void cast(state)
  })
  browser.on("disconnected", () => {
    if (opened) void opened.then((current) => current === state && reset())
  })
  await cast(state)
  return state
}

function follow(state: Open, page: Page): void {
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && page === state.page) stale = "The page navigated."
  })
  page.on("close", () => {
    if (page !== state.page) return
    const rest = state.context.pages()
    const next = rest.at(-1)
    if (!next) return
    state.page = next
    state.tabId = ++nextTab
    stale = "The tab closed."
    void cast(state)
  })
}

function reset(): void {
  opened = undefined
  pending && clearTimeout(pending.timer)
  pending = undefined
  last = undefined
  if (idle) clearTimeout(idle)
  idle = undefined
  if (owner === "user") setOwner("agent")
}

async function current(): Promise<Open> {
  opened ??= launch().catch((error) => {
    opened = undefined
    throw error
  })
  const state = await opened
  touch()
  return state
}

function touch(): void {
  if (idle) clearTimeout(idle)
  idle = setTimeout(() => {
    if (viewers.size > 0 || owner === "user") return touch()
    void close()
  }, IDLE_CLOSE_MS)
  idle.unref?.()
}

/** Close the browser (idle, tests, daemon exit). */
export async function close(): Promise<void> {
  const state = opened
  reset()
  stale = undefined
  handedBack = undefined
  notes = []
  if (!state) return
  await state.then((open) => open.browser.close()).catch(() => undefined)
}

// --- screencast -------------------------------------------------------------------------------

/** Start (or restart, for a new page or viewer) the screencast when anyone watches. */
async function cast(state: Open): Promise<void> {
  const previous = state.cdp
  state.cdp = undefined
  pending && clearTimeout(pending.timer)
  pending = undefined
  await previous?.detach().catch(() => undefined)
  if (viewers.size === 0) return
  const page = state.page
  const cdp = await page.context().newCDPSession(page)
  state.cdp = cdp
  cdp.on("Page.screencastFrame", (event) => {
    void onFrame(state, cdp, event).catch(() => cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }))
  })
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 70,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
  })
}

async function onFrame(
  state: Open,
  cdp: CDPSession,
  event: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } },
): Promise<void> {
  const ack = () => void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined)
  if (state.cdp !== cdp) return
  const jpegBase64 = await masked(state.page, event.data, event.metadata.deviceWidth)
  // Withheld: a password field is on screen and could not be painted over. Ask for the next one.
  if (jpegBase64 === undefined) return ack()
  const frame: Frame = {
    tabId: state.tabId,
    jpegBase64,
    width: Math.round(event.metadata.deviceWidth),
    height: Math.round(event.metadata.deviceHeight),
    seq: ++seq,
  }
  last = frame
  pending && clearTimeout(pending.timer)
  pending = {
    seq: frame.seq,
    ack,
    timer: setTimeout(() => {
      // Nobody acked: unstick every viewer and let Chromium go on.
      for (const view of viewers.values()) view.waiting = undefined
      pending = undefined
      ack()
    }, ACK_TIMEOUT_MS),
  }
  for (const [viewer, view] of viewers) {
    if (view.waiting !== undefined) continue
    view.waiting = frame.seq
    viewer.frame(frame)
  }
}

/** Start sending frames to a viewer. Returns the function that stops it. */
export function watch(viewer: Viewer): () => void {
  if (!viewers.has(viewer)) {
    viewers.set(viewer, {})
    viewer.control(owner)
    // A restart makes Chromium send the current picture, which a new viewer has not seen.
    if (opened) void opened.then(cast).catch(() => undefined)
  }
  return () => unwatch(viewer)
}

export function unwatch(viewer: Viewer): void {
  if (!viewers.delete(viewer)) return
  if (viewers.size > 0 || !opened) return
  void opened
    .then(async (state) => {
      const cdp = state.cdp
      state.cdp = undefined
      await cdp?.send("Page.stopScreencast").catch(() => undefined)
      await cdp?.detach().catch(() => undefined)
    })
    .catch(() => undefined)
}

/** A viewer got frame `n`: the next frame may go to it, and Chromium may send the next one. */
export function ack(viewer: Viewer, n: number): void {
  const view = viewers.get(viewer)
  if (!view || view.waiting === undefined || n < view.waiting) return
  view.waiting = undefined
  if (pending && pending.seq === n) {
    clearTimeout(pending.timer)
    const { ack: send } = pending
    pending = undefined
    send()
  }
  // It missed newer pictures while it was busy; send the latest so it does not stay behind.
  if (last && last.seq > n) {
    view.waiting = last.seq
    viewer.frame(last)
  }
}

// --- passwords --------------------------------------------------------------------------------

type Photon = typeof import("@silvia-odwyer/photon-node")
let photon: Promise<Photon> | undefined

function loadPhoton(): Promise<Photon> {
  // As image/image.ts: the patched photon-node reads this so a compiled binary finds its wasm.
  ;(globalThis as typeof globalThis & { __REDROB_PHOTON_WASM_PATH?: string }).__REDROB_PHOTON_WASM_PATH =
    path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
  photon ??= import("@silvia-odwyer/photon-node").catch((error) => {
    photon = undefined
    throw error
  })
  return photon
}

type Box = { x: number; y: number; width: number; height: number }

/** Password fields on the page, in viewport CSS pixels, iframes included. */
export async function passwordBoxes(page: Page): Promise<Box[]> {
  const boxes: Box[] = []
  for (const frame of page.frames()) {
    const fields = await frame.locator("input[type=password]").all()
    for (const field of fields) {
      const box = await field.boundingBox({ timeout: 1_000 }).catch(() => null)
      if (box && box.width > 0 && box.height > 0) boxes.push(box)
    }
  }
  return boxes
}

/**
 * The JPEG with every password field painted over; the same JPEG when there is none; undefined
 * when there is one and painting failed, so the picture must not be sent.
 */
async function masked(page: Page, jpegBase64: string, viewportWidth: number): Promise<string | undefined> {
  const boxes = await passwordBoxes(page).catch(() => undefined)
  if (boxes === undefined) return undefined
  if (boxes.length === 0) return jpegBase64
  try {
    return await paint(jpegBase64, boxes, viewportWidth)
  } catch {
    return undefined
  }
}

/** Fill each box (CSS pixels of a `viewportWidth` viewport) on the JPEG with a flat gray. */
export async function paint(jpegBase64: string, boxes: Box[], viewportWidth: number): Promise<string> {
  const { PhotonImage } = await loadPhoton()
  const image = PhotonImage.new_from_byteslice(Buffer.from(jpegBase64, "base64"))
  try {
    const width = image.get_width()
    const height = image.get_height()
    const scale = width / viewportWidth
    const pixels = image.get_raw_pixels()
    const pad = 3
    for (const box of boxes) {
      const left = Math.max(0, Math.floor((box.x - pad) * scale))
      const top = Math.max(0, Math.floor((box.y - pad) * scale))
      const right = Math.min(width, Math.ceil((box.x + box.width + pad) * scale))
      const bottom = Math.min(height, Math.ceil((box.y + box.height + pad) * scale))
      for (let y = top; y < bottom; y++)
        for (let x = left; x < right; x++) {
          const at = (y * width + x) * 4
          pixels[at] = 96
          pixels[at + 1] = 96
          pixels[at + 2] = 96
          pixels[at + 3] = 255
        }
    }
    const out = new PhotonImage(pixels, width, height)
    try {
      return Buffer.from(out.get_bytes_jpeg(80)).toString("base64")
    } finally {
      out.free()
    }
  } finally {
    image.free()
  }
}

// --- control ----------------------------------------------------------------------------------

export function controlOwner(): Owner {
  return owner
}

/** `browser.control`: the device takes the browser (`user`) or hands it back (`agent`). */
export async function control(next: Owner): Promise<void> {
  if (next === owner) return
  if (next === "agent") handedBack = await summary()
  else notes = []
  setOwner(next)
}

function setOwner(next: Owner): void {
  owner = next
  if (next === "agent") stale = "The user had the browser."
  for (const viewer of viewers.keys()) viewer.control(next)
  for (const wake of [...ownerWaiters]) wake()
}

async function summary(): Promise<string> {
  const page = opened ? await opened.then((state) => state.page).catch(() => undefined) : undefined
  const where = page ? ` Now at ${page.url()} "${await page.title().catch(() => "")}".` : ""
  const did = notes.length > 0 ? notes.join("; ") : "nothing"
  notes = []
  return `The user had the browser and handed it back. They did: ${did}.${where}`
}

function note(text: string): void {
  const previous = notes.at(-1)
  if (previous === text && text === "scrolled") return
  notes.push(text)
  if (notes.length > MAX_NOTES) notes = notes.slice(-MAX_NOTES)
}

/**
 * Before each agent action: wait while the person holds the browser (up to `TAKEOVER_WAIT_MS`),
 * then return the hand-back line once, if there is one.
 */
export async function turn(signal?: AbortSignal, waitMs = TAKEOVER_WAIT_MS): Promise<string | undefined> {
  if (owner === "user") {
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer)
        ownerWaiters.delete(check)
        signal?.removeEventListener("abort", aborted)
      }
      const check = () => {
        if (owner !== "agent") return
        done()
        resolve()
      }
      const aborted = () => {
        done()
        reject(new Error("Aborted while the user had the browser."))
      }
      const timer = setTimeout(() => {
        done()
        reject(
          new Error(
            `The user has had the browser for ${Math.round(waitMs / 60_000)} minutes and has not handed it back. Ask them before using it again.`,
          ),
        )
      }, waitMs)
      ownerWaiters.add(check)
      signal?.addEventListener("abort", aborted)
    })
  }
  const line = handedBack
  handedBack = undefined
  return line
}

export type Input =
  | {
      kind: "mouse"
      type: "mousePressed" | "mouseReleased" | "mouseMoved"
      x: number
      y: number
      button?: "none" | "left" | "middle" | "right"
      clickCount?: number
      modifiers?: number
    }
  | { kind: "scroll"; x: number; y: number; deltaX?: number; deltaY?: number; modifiers?: number }
  | {
      kind: "key"
      type: "keyDown" | "keyUp" | "rawKeyDown" | "char"
      key?: string
      code?: string
      text?: string
      windowsVirtualKeyCode?: number
      modifiers?: number
    }
  | { kind: "text"; text: string }

const finite = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value)
const shortText = (max: number) => (value: unknown) => typeof value === "string" && value.length <= max
const MODIFIERS = (value: unknown) => finite(value, 0, 15)

/** A `browser.input` body, checked field by field; undefined when it is not one. Unknown fields are dropped. */
export function parseInput(body: unknown): Input | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined
  const value = body as Record<string, unknown>
  const coords = finite(value.x, -10_000, 100_000) && finite(value.y, -10_000, 100_000)
  if (value.kind === "mouse") {
    if (value.type !== "mousePressed" && value.type !== "mouseReleased" && value.type !== "mouseMoved") return undefined
    if (!coords) return undefined
    if (!optional(value.button, (b) => b === "none" || b === "left" || b === "middle" || b === "right"))
      return undefined
    if (!optional(value.clickCount, (n) => finite(n, 0, 3)) || !optional(value.modifiers, MODIFIERS)) return undefined
    return {
      kind: "mouse",
      type: value.type,
      x: value.x as number,
      y: value.y as number,
      ...(value.button !== undefined ? { button: value.button as "left" } : {}),
      ...(value.clickCount !== undefined ? { clickCount: value.clickCount as number } : {}),
      ...(value.modifiers !== undefined ? { modifiers: value.modifiers as number } : {}),
    }
  }
  if (value.kind === "scroll") {
    if (!coords) return undefined
    if (!optional(value.deltaX, (n) => finite(n, -100_000, 100_000))) return undefined
    if (!optional(value.deltaY, (n) => finite(n, -100_000, 100_000))) return undefined
    if (!optional(value.modifiers, MODIFIERS)) return undefined
    return {
      kind: "scroll",
      x: value.x as number,
      y: value.y as number,
      ...(value.deltaX !== undefined ? { deltaX: value.deltaX as number } : {}),
      ...(value.deltaY !== undefined ? { deltaY: value.deltaY as number } : {}),
      ...(value.modifiers !== undefined ? { modifiers: value.modifiers as number } : {}),
    }
  }
  if (value.kind === "key") {
    if (value.type !== "keyDown" && value.type !== "keyUp" && value.type !== "rawKeyDown" && value.type !== "char")
      return undefined
    if (!optional(value.key, shortText(32)) || !optional(value.code, shortText(32))) return undefined
    if (!optional(value.text, shortText(8)) || !optional(value.windowsVirtualKeyCode, (n) => finite(n, 0, 255)))
      return undefined
    if (!optional(value.modifiers, MODIFIERS)) return undefined
    const { kind: _kind, ...rest } = value
    const picked = Object.fromEntries(
      Object.entries(rest).filter(([name]) =>
        ["type", "key", "code", "text", "windowsVirtualKeyCode", "modifiers"].includes(name),
      ),
    )
    return { kind: "key", ...picked } as Input
  }
  if (value.kind === "text") {
    if (typeof value.text !== "string" || value.text.length === 0 || value.text.length > 10_000) return undefined
    return { kind: "text", text: value.text }
  }
  return undefined
}

/** What is at a point (a click) or focused (typing), as the user's notes name it. */
async function describe(page: Page, point?: { x: number; y: number }) {
  return page
    .evaluate((at) => {
      const start = at ? document.elementFromPoint(at.x, at.y) : document.activeElement
      const el = (start?.closest("a,button,input,textarea,select,label,[role]") ?? start) as HTMLElement | null
      if (!el) return { label: "the page", password: false }
      const input = el as HTMLInputElement
      const label =
        el.getAttribute("aria-label") ||
        input.placeholder ||
        input.name ||
        (el.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 40) ||
        el.tagName.toLowerCase()
      return { label, password: el.tagName === "INPUT" && input.type === "password" }
    }, point)
    .catch(() => ({ label: "the page", password: false }))
}

const NAMED_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "PageDown",
  "PageUp",
])

/** One `browser.input` from the device holding the browser. */
export async function input(event: Input): Promise<void> {
  if (owner !== "user") throw new NotOwnerError("Take the browser first (browser.control owner: user).")
  const state = await current()
  const cdp = state.cdp ?? (await state.page.context().newCDPSession(state.page))
  if (event.kind === "mouse") {
    if (event.type === "mousePressed") {
      const what = await describe(state.page, event)
      note(`clicked "${what.label}"`)
    }
    const { kind: _kind, ...args } = event
    await cdp.send("Input.dispatchMouseEvent", { button: "left", clickCount: 1, ...args })
  } else if (event.kind === "scroll") {
    note("scrolled")
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: event.x,
      y: event.y,
      deltaX: event.deltaX ?? 0,
      deltaY: event.deltaY ?? 0,
      ...(event.modifiers !== undefined ? { modifiers: event.modifiers } : {}),
    })
  } else if (event.kind === "key") {
    if ((event.type === "keyDown" || event.type === "rawKeyDown") && event.key && NAMED_KEYS.has(event.key))
      note(`pressed ${event.key}`)
    const { kind: _kind, ...args } = event
    await cdp.send("Input.dispatchKeyEvent", args)
  } else {
    const what = await describe(state.page)
    note(
      what.password
        ? `typed ${[...event.text].length} characters into a password field`
        : `typed "${event.text.slice(0, 80)}" into "${what.label}"`,
    )
    await cdp.send("Input.insertText", { text: event.text })
  }
  if (cdp !== state.cdp) await cdp.detach().catch(() => undefined)
}

// --- agent actions ----------------------------------------------------------------------------

export type Reading = { url: string; title: string; text: string }

/** The page as the agent reads it: URL, title, and the numbered accessibility tree. */
export async function read(): Promise<Reading> {
  const { page } = await current()
  const tree = await page.ariaSnapshot({ mode: "ai", timeout: ACTION_TIMEOUT_MS })
  stale = undefined
  const text =
    tree.length > MAX_READ_CHARS
      ? `${tree.slice(0, MAX_READ_CHARS)}\n[cut at ${MAX_READ_CHARS} characters; scroll or wait and read again]`
      : tree
  return { url: page.url(), title: await page.title().catch(() => ""), text }
}

export async function open(url: string): Promise<Reading> {
  const { page } = await current()
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
  return settled()
}

const REF = /^[a-z]{0,2}\d{0,6}e\d{1,6}$/

function element(page: Page, ref: string) {
  if (!REF.test(ref)) throw new Error(`"${ref}" is not an element number from a reading (like e5).`)
  if (stale) throw new StaleError(stale)
  return page.locator(`aria-ref=${ref}`)
}

async function settled(): Promise<Reading> {
  const { page } = await current()
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined)
  return read()
}

export async function click(ref: string): Promise<Reading> {
  const { page } = await current()
  await element(page, ref).click({ timeout: ACTION_TIMEOUT_MS })
  return settled()
}

export async function type(ref: string, text: string, submit = false): Promise<Reading> {
  const { page } = await current()
  const field = element(page, ref)
  await field.fill(text, { timeout: ACTION_TIMEOUT_MS })
  if (submit) await field.press("Enter", { timeout: ACTION_TIMEOUT_MS })
  return settled()
}

export async function scroll(options: { ref?: string; direction?: "up" | "down"; amount?: number }): Promise<Reading> {
  const { page } = await current()
  if (options.ref) await element(page, options.ref).scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
  else {
    const amount = Math.min(Math.max(options.amount ?? 600, 1), 20_000)
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2)
    await page.mouse.wheel(0, options.direction === "up" ? -amount : amount)
    await page.waitForTimeout(200)
  }
  return read()
}

/** Wait for text to appear, or for a number of seconds (at most 60). */
export async function wait(options: { text?: string; seconds?: number }): Promise<Reading> {
  const { page } = await current()
  const ms = Math.min(Math.max(options.seconds ?? (options.text ? 30 : 1), 0), 60) * 1000
  if (options.text) await page.getByText(options.text).first().waitFor({ state: "visible", timeout: ms })
  else await page.waitForTimeout(ms)
  return read()
}

/** The visible viewport as a JPEG, password fields painted over. */
export async function screenshot(): Promise<{ jpegBase64: string; url: string }> {
  const { page } = await current()
  const shot = (await page.screenshot({ type: "jpeg", quality: 75, timeout: ACTION_TIMEOUT_MS })).toString("base64")
  const jpegBase64 = await masked(page, shot, VIEWPORT.width)
  if (jpegBase64 === undefined) throw new Error("A password field is on screen and could not be hidden; no screenshot.")
  return { jpegBase64, url: page.url() }
}

/** `GET /desk/browser`: whether it is open, who holds it, and where it is. */
export async function status(): Promise<{
  open: boolean
  owner: Owner
  tabId?: number
  url?: string
  title?: string
  width: number
  height: number
}> {
  const state = opened ? await opened.catch(() => undefined) : undefined
  if (!state) return { open: false, owner, width: VIEWPORT.width, height: VIEWPORT.height }
  return {
    open: true,
    owner,
    tabId: state.tabId,
    url: state.page.url(),
    title: await state.page.title().catch(() => ""),
    width: VIEWPORT.width,
    height: VIEWPORT.height,
  }
}

export * as RunnerBrowser from "."
