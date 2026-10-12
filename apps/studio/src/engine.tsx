import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react"
import { RedrobCode } from "@redrob-code/client"
import type { EngineInfo } from "@redrob-code/desktop/bridge"

/**
 * The engine connection: one typed client and one shared event stream for the whole window.
 *
 * The event stream is global across project folders (packages/server/src/handlers/event.ts), so it
 * is opened once here and every view filters what it needs, rather than each view opening its own.
 */

export type Client = ReturnType<typeof RedrobCode.make>

/** The fields the interface reads from an event. The full union lives in @redrob-code/protocol. */
export type EngineEvent = {
  type: string
  data?: { sessionID?: string; textID?: string; delta?: string; [key: string]: unknown }
  location?: { directory: string }
}

type Listener = (event: EngineEvent) => void

type EngineContextValue = {
  info: EngineInfo
  client: Client
  subscribe: (listener: Listener) => () => void
}

const EngineContext = createContext<EngineContextValue | null>(null)

export function useEngine() {
  const value = useContext(EngineContext)
  if (!value) throw new Error("useEngine needs an EngineProvider")
  return value
}

/** Calls the handler for every engine event, for as long as the component is mounted. */
export function useEngineEvents(handler: Listener) {
  const { subscribe } = useEngine()
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => subscribe((event) => ref.current(event)), [subscribe])
}

export function EngineProvider(props: { info: EngineInfo; children: ReactNode }) {
  const { info } = props
  const { value, listeners } = useMemo(() => {
    const client = RedrobCode.make({ baseUrl: info.url, headers: { Authorization: info.authorization } })
    const listeners = new Set<Listener>()
    const value: EngineContextValue = {
      info,
      client,
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
    return { value, listeners }
  }, [info])

  useEffect(() => {
    const controller = new AbortController()
    let attempt = 0
    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of value.client.events.subscribe({ signal: controller.signal })) {
            attempt = 0
            for (const listener of listeners) listener(event as unknown as EngineEvent)
          }
        } catch {
          if (controller.signal.aborted) return
        }
        // The stream ends when the engine restarts; reconnect with a short, growing delay.
        attempt = Math.min(attempt + 1, 6)
        await new Promise((done) => setTimeout(done, 250 * 2 ** attempt))
      }
    }
    void run()
    return () => controller.abort()
  }, [value, listeners])

  return <EngineContext.Provider value={value}>{props.children}</EngineContext.Provider>
}
