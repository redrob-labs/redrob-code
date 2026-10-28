// The engine lets a model end its reply with `[OPTIONS: a | b | c]` (see ANSWER_OPTIONS_PROMPT in
// packages/redrob/src/session/prompt.ts). Models sometimes drop the brackets, so both forms count.
const BRACKETED = /^\[OPTIONS:(.*)\]$/
const BARE = /^OPTIONS:(.*)$/
const FENCE = /^\s*```/
const MAX = 5

export type Parsed = { body: string; options: string[] }

export function parse(text: string): Parsed {
  const none = { body: text, options: [] }
  const lines = text.split("\n")
  let last = lines.length - 1
  while (last >= 0 && !lines[last]!.trim()) last--
  if (last < 0) return none

  const line = lines[last]!.trim()
  const raw = (line.match(BRACKETED) ?? line.match(BARE))?.[1]
  if (raw === undefined) return none

  // An odd number of fences above the line means it sits inside an unclosed code block.
  const fences = lines.slice(0, last).filter((item) => FENCE.test(item)).length
  if (fences % 2 === 1) return none

  const options = raw
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean)
  if (options.length < 2) return none

  return { body: lines.slice(0, last).join("\n").trimEnd(), options: options.slice(0, MAX) }
}
