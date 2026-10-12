/** A unified diff split into files and classified lines, for a read-only changes view. */

export type DiffLine = { kind: "add" | "remove" | "context" | "hunk" | "meta"; text: string }
export type DiffFile = { path: string; additions: number; deletions: number; lines: DiffLine[] }

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = / b\/(.+)$/.exec(line)
      current = { path: match?.[1] ?? line.slice(11), additions: 0, deletions: 0, lines: [] }
      files.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      continue
    }
    if (line.startsWith("@@")) current.lines.push({ kind: "hunk", text: line })
    else if (line.startsWith("+")) {
      current.additions++
      current.lines.push({ kind: "add", text: line })
    } else if (line.startsWith("-")) {
      current.deletions++
      current.lines.push({ kind: "remove", text: line })
    } else if (line.startsWith(" ")) current.lines.push({ kind: "context", text: line })
    else if (line.length > 0) current.lines.push({ kind: "meta", text: line })
  }
  return files
}
