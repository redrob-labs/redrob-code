/**
 * Keep a fetched page small enough that reading it does not cost more than the answer is worth.
 *
 * A page converted to markdown is routinely 25-35k characters (~8k tokens), and every one of those
 * tokens is re-sent on every later step of the turn. Two cuts: when the caller says what it is
 * looking for, only the lines around the matches are kept; in all cases the result is capped, with a
 * note saying how much was dropped and how to see more.
 */

export const DEFAULT_MAX_CHARS = 12_000
const CONTEXT_LINES = 8

export function focus(text: string, query: string | undefined, maxChars = DEFAULT_MAX_CHARS): string {
  const limit = Math.max(500, maxChars)
  const terms = (query ?? "")
    .split(/[\s,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2)

  let body = text
  let focused = 0
  if (terms.length > 0) {
    const lines = text.split("\n")
    const keep = new Array<boolean>(lines.length).fill(false)
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase()
      if (!terms.some((t) => lower.includes(t))) continue
      focused++
      for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(lines.length - 1, i + CONTEXT_LINES); j++) keep[j] = true
    }
    if (focused > 0) {
      const out: string[] = []
      let gap = false
      for (let i = 0; i < lines.length; i++) {
        if (keep[i]) {
          if (gap) out.push("[...]")
          out.push(lines[i])
          gap = false
        } else gap = true
      }
      body = out.join("\n")
    }
  }

  const note: string[] = []
  if (terms.length > 0) {
    note.push(
      focused > 0
        ? `[focused on "${query}": ${focused} matching lines with ${CONTEXT_LINES} lines of context, out of ${text.split("\n").length} lines]`
        : `[no line matched "${query}"; showing the start of the page]`,
    )
  }
  if (body.length > limit) {
    body = body.slice(0, limit)
    note.push(
      `[truncated: ${text.length.toLocaleString()} characters total, showing ${limit.toLocaleString()}. Pass query="..." to keep only the relevant parts, or raise max_chars.]`,
    )
  }
  return note.length ? `${body}\n\n${note.join("\n")}` : body
}
