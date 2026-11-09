/**
 * The runner browser over the desk (code-work contract 2.3): `/desk/browser*` routes and the
 * frames a watching device gets. The browser itself is `src/browser`.
 *
 * - `GET /desk/browser` → `{ open, owner, tabId?, url?, title?, width, height }`
 * - `POST /desk/browser/watch` `{ on: boolean }`: start or stop frames to this device. While on, the
 *   device gets `{ t: "browser.frame", type: "browser.frame", source: "runner", tabId, jpegBase64,
 *   width, height, seq }` (width/height: the viewport in CSS pixels, the space `Input.*` uses) and
 *   `{ t: "browser.control", type: "browser.control", owner }` whenever the owner changes.
 * - `POST /desk/browser/ack` `{ seq }`: frame `seq` arrived; the next is sent only after this.
 * - `POST /desk/browser/control` `{ owner: "user" | "agent" }`: take the browser or hand it back.
 * - `POST /desk/browser/input` `{ kind: "mouse" | "key" | "text" | "scroll", ... }`: CDP `Input.*`
 *   arguments; 409 unless this side holds the browser.
 *
 * watch and ack change nothing on the PC, so a `read_only` machine answers them (viewing only);
 * control and input are refused there by the forwarder.
 */
import { RunnerBrowser } from "../browser"
import type { Link } from "./forward"

export type ScreenCall = "status" | "watch" | "ack" | "control" | "input"

const viewers = new WeakMap<Link, RunnerBrowser.Viewer>()

function viewer(link: Link): RunnerBrowser.Viewer {
  let found = viewers.get(link)
  if (!found) {
    found = {
      frame: (frame) =>
        void link
          .send({ t: "browser.frame", type: "browser.frame", source: "runner", ...frame })
          .catch(() => undefined),
      control: (owner) =>
        void link.send({ t: "browser.control", type: "browser.control", owner }).catch(() => undefined),
    }
    viewers.set(link, found)
  }
  return found
}

/** The device went away: no more frames to it. */
export function forget(link: Link): void {
  const found = viewers.get(link)
  if (found) RunnerBrowser.unwatch(found)
  viewers.delete(link)
}

const object = (body: unknown): Record<string, unknown> | undefined =>
  typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined

/** Body rules for the forwarder's allowlist; a body failing one is answered 400. */
export const bodies = {
  watch: (body: unknown) => typeof object(body)?.on === "boolean",
  ack: (body: unknown) => {
    const seq = object(body)?.seq
    return typeof seq === "number" && Number.isInteger(seq) && seq >= 0
  },
  control: (body: unknown) => {
    const owner = object(body)?.owner
    return owner === "user" || owner === "agent"
  },
  input: (body: unknown) => RunnerBrowser.parseInput(body) !== undefined,
}

export async function screenRequest(
  call: ScreenCall,
  link: Link,
  body: unknown,
): Promise<{ status: number; body?: unknown }> {
  const value = object(body) ?? {}
  try {
    if (call === "status") return { status: 200, body: await RunnerBrowser.status() }
    if (call === "watch") {
      if (value.on === true) RunnerBrowser.watch(viewer(link))
      else forget(link)
      return { status: 200, body: { on: value.on === true } }
    }
    if (call === "ack") {
      const found = viewers.get(link)
      if (found) RunnerBrowser.ack(found, value.seq as number)
      return { status: 200, body: {} }
    }
    if (call === "control") {
      await RunnerBrowser.control(value.owner as RunnerBrowser.Owner)
      return { status: 200, body: { owner: RunnerBrowser.controlOwner() } }
    }
    await RunnerBrowser.input(RunnerBrowser.parseInput(body)!)
    return { status: 200, body: {} }
  } catch (error) {
    if (error instanceof RunnerBrowser.NotOwnerError) return { status: 409, body: { error: error.message } }
    if (error instanceof RunnerBrowser.UnavailableError) return { status: 503, body: { error: error.message } }
    return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } }
  }
}
