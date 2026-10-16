/**
 * Turn the assistant's markdown into text a chat platform shows sensibly, then split it to fit.
 *
 * "Plain-ish": headings become their text, emphasis markers are dropped, links become
 * `text (url)`, list markers become bullets, tables are left as-is (monospace is the best any
 * platform does). Code fences are kept verbatim so a transport that supports them (Slack, Discord,
 * Telegram MarkdownV2) can still show code as code; splitting never cuts inside a fence when it
 * can avoid it, and re-opens the fence in the next chunk when it cannot.
 */

export const DEFAULT_MAX_CHUNK = 3900

export function toPlainText(markdown: string): string {
  const out: string[] = []
  let inFence = false
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence
      out.push(raw)
      continue
    }
    if (inFence) {
      out.push(raw)
      continue
    }
    let line = raw
    line = line.replace(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/, "$1")
    line = line.replace(/^\s*>\s?/, "")
    line = line.replace(/^(\s*)[-*+]\s+/, "$1• ")
    line = line.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    line = line.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, text: string, url: string) =>
      text === url ? url : `${text} (${url})`,
    )
    line = line.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    line = line.replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1$2")
    line = line.replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2")
    line = line.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    line = line.replace(/^\s*([-*_])(\s*\1){2,}\s*$/, "────────")
    out.push(line)
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

type Fence = { open: string } | undefined

function fenceState(text: string): Fence {
  let open: Fence
  for (const line of text.split("\n")) {
    const m = /^\s*(```|~~~)(.*)$/.exec(line)
    if (!m) continue
    if (open) open = undefined
    else open = { open: m[1] + m[2].trim() }
  }
  return open
}

/** Where to cut `text` so the first piece is at most `limit` chars: a blank line, a newline, a space, else hard. */
function cutPoint(text: string, limit: number): number {
  if (text.length <= limit) return text.length
  const window = text.slice(0, limit)
  const paragraph = window.lastIndexOf("\n\n")
  if (paragraph > limit * 0.4) return paragraph
  const line = window.lastIndexOf("\n")
  if (line > limit * 0.4) return line
  const space = window.lastIndexOf(" ")
  if (space > limit * 0.4) return space
  return limit
}

/** Split into chunks of at most `limit` characters, keeping code fences balanced per chunk. */
export function split(text: string, limit = DEFAULT_MAX_CHUNK): string[] {
  const max = Math.max(64, Math.floor(limit))
  const chunks: string[] = []
  let rest = text
  let reopen = ""
  while (rest.length > 0) {
    let piece = reopen + rest
    if (piece.length <= max) {
      chunks.push(piece)
      break
    }
    let at = cutPoint(piece, max)
    let head = piece.slice(0, at)
    const fence = fenceState(head)
    if (fence) {
      // Cutting inside a fence: close it here and re-open it in the next chunk. Make room for the
      // closing marker; if that pushes us too far back, accept the cut and let the platform cope.
      const closer = "\n" + fence.open.slice(0, 3)
      if (head.length + closer.length > max) {
        at = cutPoint(piece, max - closer.length)
        head = piece.slice(0, at)
      }
      head = head.trimEnd() + closer
      reopen = fence.open + "\n"
    } else {
      reopen = ""
    }
    chunks.push(head.trimEnd())
    rest = piece.slice(at).replace(/^\n+/, "")
  }
  return chunks.filter((c) => c.trim().length > 0)
}

/** Render a markdown reply into platform-sized chunks. */
export function render(markdown: string, limit = DEFAULT_MAX_CHUNK): string[] {
  const text = toPlainText(markdown)
  if (text.length === 0) return []
  return split(text, limit)
}
