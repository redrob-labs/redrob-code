/**
 * The daemon's own HTTP API, as the desk forwarder calls it: 127.0.0.1 with the daemon's Basic
 * header (`DaemonConnection` from `redrob serve --register`). Routes are the session, permission
 * and apps groups of `@redrob-code/protocol` and the global event stream (`GET /api/event`).
 */
import type { DaemonConnection } from "@redrob-code/channels-core"

export type BridgedApp = {
  readonly id: string
  readonly name: string
  readonly mcpUrl: string
  readonly pid: number
  readonly version?: string
  readonly tools?: readonly string[]
  readonly registeredAt: number
  readonly lastSeen: number
}

/** One event off the bus: `{ id?, type, data, durable? }`. */
export type BusEvent = {
  readonly id?: string
  readonly type: string
  readonly data: Record<string, unknown>
  readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
}

export class DaemonError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export class DaemonApi {
  constructor(private readonly daemon: DaemonConnection) {}

  private url(path: string): string {
    return `${this.daemon.url.replace(/\/+$/, "")}${path}`
  }

  /** One call, whatever the status: the forwarder hands the status and body to the phone as is. */
  async raw(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 30_000): Promise<{ status: number; body?: unknown }> {
    const response = await fetch(this.url(path), {
      method,
      headers: {
        ...this.daemon.headers,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text().catch(() => "")
    if (!text) return { status: response.status }
    try {
      return { status: response.status, body: JSON.parse(text) as unknown }
    } catch {
      return { status: response.status }
    }
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const result = await this.raw(method, path, body)
    if (result.status < 200 || result.status >= 300) throw new DaemonError(result.status, `${method} ${path}: ${result.status}`)
    return result.body as T
  }

  async sessionTitle(id: string): Promise<string | undefined> {
    const result = await this.call<{ data?: { title?: unknown } }>("GET", `/api/session/${encodeURIComponent(id)}`)
    return typeof result?.data?.title === "string" ? result.data.title : undefined
  }

  /** Resolves when the session's agent loop is idle. A turn can run for a long time. */
  async wait(id: string, signal?: AbortSignal): Promise<void> {
    const response = await fetch(this.url(`/api/session/${encodeURIComponent(id)}/wait`), {
      method: "POST",
      headers: { ...this.daemon.headers },
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) throw new DaemonError(response.status, `wait ${id}: ${response.status}`)
  }

  async apps(): Promise<{ apps: BridgedApp[]; ttlMs: number }> {
    return this.call("GET", "/v1/apps")
  }

  /**
   * Follow `GET /api/event` until `signal` aborts or the stream ends. Each SSE `data:` payload is
   * one bus event. Resolves when the stream closes; the caller reconnects.
   */
  async events(onEvent: (event: BusEvent) => void, signal: AbortSignal): Promise<void> {
    const response = await fetch(this.url("/api/event"), {
      headers: { ...this.daemon.headers, Accept: "text/event-stream" },
      signal,
    })
    if (!response.ok || !response.body) throw new DaemonError(response.status, `event stream: ${response.status}`)
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""
    let data: string[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += value
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "")
        buffer = buffer.slice(newline + 1)
        if (line === "") {
          if (data.length > 0) {
            try {
              const event = JSON.parse(data.join("\n")) as BusEvent
              if (event && typeof event.type === "string") onEvent(event)
            } catch {
              // A malformed payload is skipped; the next one may be fine.
            }
          }
          data = []
          continue
        }
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
      }
    }
  }
}
