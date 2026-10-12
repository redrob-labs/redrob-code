/**
 * The engine's startup handshake, read from the other side.
 *
 * `redrob serve` prints `redrob server listening on http://host:port` once it is bound
 * (`SERVER_LISTENING_PREFIX` in packages/redrob/src/cli/cmd/serve.ts). The prefix is duplicated here
 * rather than imported because importing serve.ts would pull the whole engine into the Electron main
 * bundle; test/listening.test.ts reads serve.ts and fails if the two ever disagree.
 */
export const SERVER_LISTENING_PREFIX = "redrob server listening"

/** The base URL from one line of output, or null when the line is something else. */
export function parseListeningUrl(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith(SERVER_LISTENING_PREFIX)) return null
  const match = /\son\s+(https?:\/\/\S+)/.exec(trimmed)
  return match?.[1]?.replace(/\/+$/, "") ?? null
}

/**
 * Splits a stream into lines and reports the first listening URL. Fed chunk by chunk, because a
 * chunk boundary can fall in the middle of the line.
 */
export function createLineScanner(onUrl: (url: string) => void) {
  let buffer = ""
  let found = false
  return (chunk: string) => {
    if (found) return
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      const url = parseListeningUrl(line)
      if (url) {
        found = true
        onUrl(url)
        return
      }
    }
  }
}
