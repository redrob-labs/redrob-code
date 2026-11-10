/**
 * Terminal streams over the desk relay (code-work design 10.2). The engine's PTY websocket
 * (`GET /pty/:id/connect`) cannot cross the relay as is, so its bytes ride sealed `desk.msg`
 * messages instead:
 *
 *   device -> desk  { t: "stream", op: "open", sid, path: "/pty/<id>/connect?directory=..&cursor=..", machineId? }
 *   desk -> device  { t: "stream", op: "open", sid, status }      200 open; 403/404/421/429 refused
 *   both ways       { t: "stream", op: "data", sid, data }        UTF-8 text (terminal output, typed keys)
 *   desk -> device  { t: "stream", op: "data", sid, b64 }         a binary frame, base64 (the PTY's
 *                                                                 0x00 + {"cursor":n} meta frame)
 *   both ways       { t: "stream", op: "close", sid, code? }      either side ends it
 *
 * `sid` is the device's number for the stream. Output is gathered for a few milliseconds so a
 * burst goes out as one message. A device has at most MAX_STREAMS open; they end with its session.
 */
import type { DaemonApi } from "./daemon"

export const MAX_STREAMS = 8
const FLUSH_MS = 12
const FLUSH_BYTES = 64 * 1024
/** One typed message from the device; a paste larger than this is refused. */
const MAX_INPUT = 256 * 1024

export type StreamSend = (message: Record<string, unknown>) => Promise<void>

type Open = {
  readonly socket: WebSocket
  pending: string
  timer?: ReturnType<typeof setTimeout>
  closed: boolean
}

export class Streams {
  private readonly open = new Map<number, Open>()

  constructor(
    private readonly daemon: Pick<DaemonApi, "socket">,
    private readonly send: StreamSend,
  ) {}

  get size(): number {
    return this.open.size
  }

  private flush(sid: number, stream: Open): void {
    if (stream.timer) clearTimeout(stream.timer)
    stream.timer = undefined
    if (!stream.pending) return
    const data = stream.pending
    stream.pending = ""
    void this.send({ t: "stream", op: "data", sid, data }).catch(() => undefined)
  }

  private end(sid: number, code?: number, tell = true): void {
    const stream = this.open.get(sid)
    if (!stream || stream.closed) return
    stream.closed = true
    this.flush(sid, stream)
    this.open.delete(sid)
    try {
      stream.socket.close()
    } catch {
      // Already closed.
    }
    if (tell) void this.send({ t: "stream", op: "close", sid, ...(code ? { code } : {}) }).catch(() => undefined)
  }

  /** Open the daemon websocket for an allowed path; resolves with the status told to the device. */
  async start(sid: number, path: string): Promise<number> {
    if (this.open.has(sid)) return 409
    if (this.open.size >= MAX_STREAMS) return 429
    const socket = this.daemon.socket(path)
    socket.binaryType = "arraybuffer"
    const stream: Open = { socket, pending: "", closed: false }
    this.open.set(sid, stream)
    const opened = await new Promise<boolean>((resolve) => {
      socket.addEventListener("open", () => resolve(true), { once: true })
      socket.addEventListener("error", () => resolve(false), { once: true })
      socket.addEventListener("close", () => resolve(false), { once: true })
    })
    if (!opened || stream.closed) {
      this.open.delete(sid)
      stream.closed = true
      return 404
    }
    socket.addEventListener("message", (event) => {
      if (stream.closed) return
      const data = event.data as string | ArrayBuffer
      if (typeof data === "string") {
        stream.pending += data
        if (stream.pending.length >= FLUSH_BYTES) this.flush(sid, stream)
        else stream.timer ??= setTimeout(() => this.flush(sid, stream), FLUSH_MS)
        return
      }
      this.flush(sid, stream)
      void this.send({ t: "stream", op: "data", sid, b64: Buffer.from(data).toString("base64") }).catch(() => undefined)
    })
    socket.addEventListener("close", (event) => this.end(sid, event.code))
    return 200
  }

  /** A `data` or `close` from the device. */
  input(sid: number, op: unknown, data: unknown): void {
    const stream = this.open.get(sid)
    if (!stream) return
    if (op === "close") return this.end(sid, undefined, false)
    if (op !== "data" || typeof data !== "string" || data.length > MAX_INPUT) return
    if (stream.socket.readyState === WebSocket.OPEN) stream.socket.send(data)
  }

  /** The device went away: end every stream without telling it. */
  closeAll(): void {
    for (const sid of [...this.open.keys()]) this.end(sid, undefined, false)
  }
}
