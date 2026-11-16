/**
 * Shell commands that only read (`grep`, `cat`, `ls`, `git status`, `sed -n`, ...), for the
 * device approval modes (permission/mobile.ts): in `edits` they run without asking, as file reads do.
 *
 * Conservative on purpose: anything this does not understand is not read-only. A command is
 * read-only when every simple command in it (split on `&&`, `||`, `;`, `|`, newlines, and inside
 * `$(...)`) is a known reader with no writing flag, and nothing writes through a redirection
 * (only `>/dev/null`, `2>/dev/null`, `2>&1`, `&>/dev/null` are allowed). Backticks, `<(...)`,
 * here-docs and `eval`-like commands are never read-only.
 */

/** Readers that are read-only with any arguments. */
const READERS = new Set([
  "cat", "head", "tail", "wc", "ls", "ll", "tree", "pwd", "echo", "printf", "true", "false", "test", "[",
  "grep", "egrep", "fgrep", "rg", "ag", "file", "stat", "du", "df", "which", "type", "whereis", "basename",
  "dirname", "realpath", "readlink", "sort", "uniq", "cut", "tr", "nl", "column", "diff", "cmp", "jq",
  "whoami", "id", "uname", "printenv", "cd", "pushd", "popd", "seq", "md5sum",
  "sha1sum", "sha256sum", "od", "hexdump", "strings", "comm", "fold", "rev", "tac", "expand", "paste",
  // Redrob's preview browser in a cloud sandbox: looks at the page, writes only its screenshot.
  "redrob-preview",
])

/** git subcommands that only read. */
const GIT_READ = new Set([
  "status", "diff", "log", "show", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "describe",
  "shortlog", "cat-file", "rev-list", "merge-base", "name-rev", "whatchanged", "reflog",
])

const FIND_WRITES = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/

const SAFE_REDIRECT = /^(?:[012]?>|&>)\/dev\/null$|^[12]>&[12]$/

/** Splits on control operators outside quotes; `$(...)` bodies are returned as separate commands. */
function split(command: string): string[] | null {
  const parts: string[] = []
  let cur = ""
  let quote: "'" | '"' | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote === "'") {
      cur += c
      if (c === "'") quote = null
      continue
    }
    if (c === "\\") {
      cur += c + (command[i + 1] ?? "")
      i++
      continue
    }
    if (c === "`") return null
    if (c === "$" && command[i + 1] === "(") {
      if (command[i + 2] === "(") return null // arithmetic: keep it simple
      let depth = 1
      let j = i + 2
      let q: string | null = null
      for (; j < command.length && depth > 0; j++) {
        const d = command[j]!
        if (q) {
          if (d === q) q = null
        } else if (d === "'" || d === '"') q = d
        else if (d === "(") depth++
        else if (d === ")") depth--
      }
      if (depth !== 0) return null
      const inner = split(command.slice(i + 2, j - 1))
      if (!inner) return null
      parts.push(...inner)
      cur += "X"
      i = j - 1
      continue
    }
    if (quote === '"') {
      cur += c
      if (c === '"') quote = null
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      cur += c
      continue
    }
    if (c === "<" && (command[i + 1] === "(" || command[i + 1] === "<")) return null
    if (c === ">" && command[i + 1] === "(") return null
    if (c === "&" && command[i + 1] === "&") {
      parts.push(cur)
      cur = ""
      i++
      continue
    }
    if (c === "|") {
      parts.push(cur)
      cur = ""
      if (command[i + 1] === "|") i++
      continue
    }
    if (c === ";" || c === "\n") {
      parts.push(cur)
      cur = ""
      continue
    }
    if (c === "&" && command[i + 1] !== ">" && command[i - 1] !== ">") return null // background job
    cur += c
  }
  if (quote) return null
  parts.push(cur)
  return parts
}

/** Words of one simple command with quotes removed; redirections kept as their own words. */
function words(part: string): string[] {
  const out: string[] = []
  let token: string | null = null
  let quote: string | null = null
  for (let i = 0; i < part.length; i++) {
    const c = part[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === "\\" && quote === '"') token += part[++i] ?? ""
      else token += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      token ??= ""
      continue
    }
    if (c === "\\") {
      token = (token ?? "") + (part[++i] ?? "")
      continue
    }
    if (/\s/.test(c)) {
      if (token !== null) out.push(token)
      token = null
      continue
    }
    token = (token ?? "") + c
  }
  if (token !== null) out.push(token)
  return out
}

function simpleReadOnly(part: string): boolean {
  const list = words(part.trim())
  // Redirections: only to /dev/null or between stdout/stderr.
  const args: string[] = []
  for (let i = 0; i < list.length; i++) {
    const w = list[i]!
    if (/^(?:[012]?>>?|&>>?)/.test(w) || w.includes(">")) {
      const joined = /^(?:[012]?>|&>)$/.test(w) ? w + (list[++i] ?? "") : w
      if (!SAFE_REDIRECT.test(joined)) return false
      continue
    }
    if (/^[012]?</.test(w)) {
      if (w === "<" || /^[012]?<$/.test(w)) i++
      continue
    }
    args.push(w)
  }
  // Leading VAR=value assignments.
  while (args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0]!)) args.shift()
  if (!args.length) return true
  const [cmd, ...rest] = args
  const name = cmd!.split("/").pop()!
  if (READERS.has(name)) return true
  if (name === "find") return !rest.some((a) => FIND_WRITES.test(a))
  if (name === "sed") {
    if (rest.some((a) => a === "-i" || a.startsWith("-i") || a.startsWith("--in-place"))) return false
    if (!rest.some((a) => a === "-n" || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))) return false
    // Script commands that write a file or run one.
    return !rest.some((a) => /(^|[;}\s])[wWe]\s|(^|[;}\s])[wW]$/.test(a))
  }
  if (name === "git") {
    let i = 0
    while (i < rest.length && rest[i]!.startsWith("-")) i += rest[i] === "-C" || rest[i] === "-c" ? 2 : 1
    const sub = rest[i]
    if (!sub) return false
    if (GIT_READ.has(sub)) return !rest.slice(i + 1).some((a) => a === "--output" || a.startsWith("--output="))
    if (sub === "branch" || sub === "tag" || sub === "remote" || sub === "stash")
      return rest.slice(i + 1).every((a) => ["-a", "-r", "-v", "-vv", "--list", "-l", "list", "show", "--show-current"].includes(a))
    return false
  }
  return false
}

export function isReadOnlyCommand(command: string): boolean {
  if (!command.trim() || command.length > 4000) return false
  const parts = split(command)
  if (!parts) return false
  const simple = parts.map((p) => p.trim()).filter(Boolean)
  return simple.length > 0 && simple.every(simpleReadOnly)
}
