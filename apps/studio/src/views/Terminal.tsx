import { useEffect, useRef, useState } from "react"
import { Alert, Loader } from "@redrob-labs/ui"
import { Terminal as XTerm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { useEngine } from "../engine"
import { useT } from "../i18n"

/**
 * A real shell in the project folder, run by the engine's pty service.
 *
 * The browser WebSocket cannot send an Authorization header, so the socket is opened with a
 * single-use ticket minted over authenticated HTTP (packages/server/src/handlers/pty.ts). Output is
 * raw bytes; one binary frame starting with 0x00 carries the resume cursor and is not shown. Resizing
 * goes through `ptys.update`, not the socket. Running the shell in the engine rather than in Electron
 * keeps native modules out of the app.
 */
export function Terminal(props: { directory: string }) {
  const t = useT()
  const { client, info } = useEngine()
  const host = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<"starting" | "open" | { error: string }>("starting")

  useEffect(() => {
    if (!host.current) return
    const location = { directory: props.directory }
    // A literal font stack: xterm measures glyphs on a canvas, which cannot resolve CSS variables.
    const term = new XTerm({
      fontFamily: '"Cascadia Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    fit.fit()

    let socket: WebSocket | null = null
    let ptyID: string | null = null
    let disposed = false
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()

    const connect = async () => {
      const created = await client.ptys.create({ location, cwd: props.directory, title: "Redrob Code" })
      ptyID = created.data.id
      if (disposed) return
      await client.ptys.update({ ptyID, location, size: { rows: term.rows, cols: term.cols } })

      const tokenUrl = new URL(`/api/pty/${encodeURIComponent(ptyID)}/connect-token`, info.url)
      tokenUrl.searchParams.set("location[directory]", props.directory)
      const response = await fetch(tokenUrl, {
        method: "POST",
        headers: { Authorization: info.authorization, "x-redrob-ticket": "1" },
      })
      if (!response.ok) throw new Error(`connect-token answered ${response.status}`)
      const { data } = (await response.json()) as { data: { ticket: string } }
      if (disposed) return

      const socketUrl = new URL(`/api/pty/${encodeURIComponent(ptyID)}/connect`, info.url)
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:"
      socketUrl.searchParams.set("ticket", data.ticket)
      socketUrl.searchParams.set("location[directory]", props.directory)
      socket = new WebSocket(socketUrl)
      socket.binaryType = "arraybuffer"
      socket.onopen = () => setStatus("open")
      socket.onmessage = (message) => {
        if (typeof message.data === "string") return term.write(message.data)
        const bytes = new Uint8Array(message.data as ArrayBuffer)
        if (bytes[0] === 0) return // the cursor control frame
        term.write(decoder.decode(bytes, { stream: true }))
      }
      socket.onclose = (event) => {
        if (!disposed && event.code !== 1000) setStatus({ error: `closed (${event.code})` })
      }
    }

    const input = term.onData((value) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(value))
    })
    const resize = new ResizeObserver(() => {
      fit.fit()
      if (ptyID)
        void client.ptys.update({ ptyID, location, size: { rows: term.rows, cols: term.cols } }).catch(() => {})
    })
    resize.observe(host.current)

    connect().catch((error: unknown) => setStatus({ error: error instanceof Error ? error.message : String(error) }))

    return () => {
      disposed = true
      resize.disconnect()
      input.dispose()
      socket?.close(1000)
      if (ptyID) void client.ptys.remove({ ptyID, location }).catch(() => {})
      term.dispose()
    }
  }, [client, info, props.directory])

  return (
    <div className="rc-terminal">
      {status === "starting" && <Loader label={t("terminal.starting")} showLabel size="sm" />}
      {typeof status === "object" && <Alert tone="danger">{t("terminal.failed", { message: status.error })}</Alert>}
      <div ref={host} className="rc-terminal__host" />
    </div>
  )
}
