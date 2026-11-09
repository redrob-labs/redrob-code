/**
 * The person's own files, for Redrob Chat's `pc_find_folder`, `pc_list` and `pc_read_file` (desk
 * routes `GET /desk/files/find|list|read`, see forward.ts).
 *
 * Only folders the person allowed are listed or read. Redrob Desktop keeps that list (its store
 * record `policy/folders`) and mirrors it to `~/.redrob/desk/folders.json` (`{ folders }`), read on
 * every call. A folder outside it is asked about at the PC: the daemon writes
 * `~/.redrob/desk/folder-asks/<id>.ask.json` (`{ id, folder, device, expiresAt }`), Redrob Desktop shows
 * "allow this folder?" and writes `<id>.answer.json` (`{ allow }`), adding the folder to its list
 * when allowed. Redrob Desktop touches `folder-asks/.desktop` while it runs; when it is not running
 * nobody can answer, so nothing is asked and the call fails at once.
 *
 * Finding a folder by name only returns folder paths (no contents) from the allowed folders and the
 * usual places (Desktop, Documents, Downloads); reading what is inside still needs the folder allowed.
 */
import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { deskHome } from "./settings"

/** One piece of a file: at most this many bytes, which is also the default. */
export const FILE_CHUNK_BYTES = 512 * 1024
/** How long the person at the PC has to answer "allow this folder?". */
export const ASK_WAIT_MS = 120_000
/** Redrob Desktop touches its marker every few seconds; older than this, it is not running. */
const DESKTOP_FRESH_MS = 20_000
const FIND_MAX_RESULTS = 20
const FIND_MAX_DEPTH = 5
const FIND_MAX_DIRS = 20_000
const FIND_BUDGET_MS = 4_000
const LIST_MAX_ENTRIES = 2_000

export function deskDir(): string {
  return path.join(deskHome(), ".redrob", "desk")
}

const asksDir = () => path.join(deskDir(), "folder-asks")

/** A failure with the status the forwarder answers and a short machine-readable reason. */
export class FilesError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason)
  }
}

/** Absolute, trimmed, no trailing separator; undefined for anything else. */
function normalize(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim().normalize("NFC")
  if (!trimmed || !path.isAbsolute(trimmed) || trimmed.includes("\0")) return undefined
  return path.resolve(trimmed)
}

/** The allowed folders, resolved; missing ones drop out. */
export async function allowedFolders(): Promise<string[]> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path.join(deskDir(), "folders.json"), "utf8"))
  } catch {
    return []
  }
  const list = (value as { folders?: unknown } | null)?.folders
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const entry of list) {
    const folder = normalize(entry)
    if (!folder) continue
    const real = await realpath(folder).catch(() => undefined)
    if (real && !out.includes(real)) out.push(real)
  }
  return out
}

function within(real: string, root: string): boolean {
  const relative = path.relative(root, real)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

const insideAny = (real: string, roots: string[]) => roots.some((root) => within(real, root))

/** The usual places a person keeps work, those that exist. */
async function usualRoots(): Promise<string[]> {
  const home = homedir()
  const names = ["Desktop", "Documents", "Downloads", "바탕화면", "바탕 화면", "문서", "다운로드", "OneDrive"]
  const out: string[] = []
  for (const name of names) {
    const real = await realpath(path.join(home, name)).catch(() => undefined)
    if (real && !out.includes(real) && (await stat(real).then((s) => s.isDirectory(), () => false))) out.push(real)
  }
  return out
}

const comparable = (value: string) => value.normalize("NFC").toLowerCase().replace(/[\s_\-·.]+/g, "")
const skipped = (name: string) =>
  name.startsWith(".") || name === "node_modules" || name === "$RECYCLE.BIN" || name === "Library"

/** Folders whose name contains `name` (spaces and case ignored), nearest first. */
export async function findFolders(name: unknown): Promise<{ folders: { path: string; allowed: boolean }[] }> {
  if (typeof name !== "string" || !comparable(name)) throw new FilesError(400, "bad_name")
  const wanted = comparable(name)
  const allowed = await allowedFolders()
  const roots = [...allowed, ...(await usualRoots()).filter((r) => !insideAny(r, allowed))]
  const found: { path: string; allowed: boolean; exact: boolean }[] = []
  const seen = new Set<string>()
  const deadline = Date.now() + FIND_BUDGET_MS
  let visited = 0
  // Breadth first, so a near folder is found before the budget runs out.
  let level = roots.map((root) => ({ dir: root, depth: 0 }))
  for (const root of roots) {
    if (comparable(path.basename(root)).includes(wanted)) {
      found.push({ path: root, allowed: insideAny(root, allowed), exact: comparable(path.basename(root)) === wanted })
      seen.add(root)
    }
  }
  while (level.length && found.length < FIND_MAX_RESULTS * 2 && visited < FIND_MAX_DIRS && Date.now() < deadline) {
    const next: typeof level = []
    for (const { dir, depth } of level) {
      if (visited++ >= FIND_MAX_DIRS || Date.now() >= deadline) break
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory() || skipped(entry.name)) continue
        const child = path.join(dir, entry.name)
        if (seen.has(child)) continue
        seen.add(child)
        const key = comparable(entry.name)
        if (key.includes(wanted)) found.push({ path: child, allowed: insideAny(child, allowed), exact: key === wanted })
        if (depth + 1 < FIND_MAX_DEPTH) next.push({ dir: child, depth: depth + 1 })
      }
    }
    level = next
  }
  found.sort((a, b) => Number(b.exact) - Number(a.exact))
  return { folders: found.slice(0, FIND_MAX_RESULTS).map(({ path, allowed }) => ({ path, allowed })) }
}

/** Whether Redrob Desktop is running to answer an ask (its marker was touched lately). */
async function desktopRunning(): Promise<boolean> {
  const info = await stat(path.join(asksDir(), ".desktop")).catch(() => undefined)
  return info !== undefined && Date.now() - info.mtimeMs < DESKTOP_FRESH_MS
}

/** Asks running per folder, so ten reads in one new folder ask once. */
const asking = new Map<string, Promise<boolean>>()
/** Folders just allowed at the PC, until the desktop's list (folders.json) has caught up. */
const answered = new Map<string, number>()
const ANSWERED_MS = 5 * 60_000
const recentlyAllowed = () => [...answered].filter(([, until]) => until > Date.now()).map(([folder]) => folder)

/** Asks the person at the PC to allow `folder`; true when they did. */
export function askFolder(folder: string, device: string | undefined, waitMs = ASK_WAIT_MS): Promise<boolean> {
  const running = asking.get(folder)
  if (running) return running
  const ask = (async () => {
    if (!(await desktopRunning())) throw new FilesError(409, "desktop_not_running")
    const id = randomUUID()
    const dir = asksDir()
    await mkdir(dir, { recursive: true })
    const askFile = path.join(dir, `${id}.ask.json`)
    const answerFile = path.join(dir, `${id}.answer.json`)
    const expiresAt = Date.now() + waitMs
    await writeFile(askFile, JSON.stringify({ id, folder, device: device ?? null, expiresAt }), "utf8")
    try {
      while (Date.now() < expiresAt) {
        const answer = await readFile(answerFile, "utf8").then(
          (text) => JSON.parse(text) as { allow?: unknown },
          () => undefined,
        )
        if (answer) return answer.allow === true
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
      throw new FilesError(408, "folder_ask_timeout")
    } finally {
      await rm(askFile, { force: true })
      await rm(answerFile, { force: true })
    }
  })()
  asking.set(folder, ask)
  ask.then(
    (allow) => {
      if (allow) answered.set(folder, Date.now() + ANSWERED_MS)
    },
    () => undefined,
  ).finally(() => asking.delete(folder))
  return ask
}

/**
 * `target` resolved inside an allowed folder. A target outside every allowed folder asks about
 * `folderOf(real)` first; refused, it fails 403.
 */
async function permitted(target: unknown, folderOf: (real: string) => string, device?: string): Promise<string> {
  const wanted = normalize(target)
  if (!wanted) throw new FilesError(400, "bad_path")
  const real = await realpath(wanted).catch(() => undefined)
  if (!real) throw new FilesError(404, "not_found")
  const roots = [...(await allowedFolders()), ...recentlyAllowed()]
  if (insideAny(real, roots)) return real
  if (!(await askFolder(folderOf(real), device))) throw new FilesError(403, "folder_denied")
  return real
}

export type ListEntry = { name: string; path: string; kind: "file" | "folder"; size: number; modified: number }

/** What is directly inside `folder`: folders first, then files, by name. */
export async function listFolder(folder: unknown, device?: string): Promise<{ path: string; entries: ListEntry[] }> {
  const real = await permitted(folder, (r) => r, device)
  const info = await stat(real)
  if (!info.isDirectory()) throw new FilesError(400, "not_a_folder")
  const entries: ListEntry[] = []
  for (const entry of await readdir(real, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entries.length >= LIST_MAX_ENTRIES) continue
    if (!entry.isDirectory() && !entry.isFile()) continue
    const child = path.join(real, entry.name)
    const s = await stat(child).catch(() => undefined)
    if (!s) continue
    entries.push({
      name: entry.name,
      path: child,
      kind: entry.isDirectory() ? "folder" : "file",
      size: entry.isDirectory() ? 0 : s.size,
      modified: Math.round(s.mtimeMs),
    })
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "ko") : a.kind === "folder" ? -1 : 1))
  return { path: real, entries }
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  hwp: "application/x-hwp",
  hwpx: "application/hwp+zip",
  odt: "application/vnd.oasis.opendocument.text",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  rtf: "application/rtf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

export function mimeOf(name: string): string {
  return MIME[path.extname(name).slice(1).toLowerCase()] ?? "application/octet-stream"
}

/** One piece of a file in an allowed folder, base64. */
export async function readFilePiece(
  target: unknown,
  range: { offset: number; limit: number },
  device?: string,
): Promise<{ name: string; path: string; mime: string; size: number; offset: number; data: string }> {
  const real = await permitted(target, (r) => path.dirname(r), device)
  const file = await open(real, "r")
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new FilesError(400, "not_a_file")
    const offset = Math.min(range.offset, info.size)
    const buffer = Buffer.alloc(Math.min(range.limit, info.size - offset))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
    const name = path.basename(real)
    return {
      name,
      path: real,
      mime: mimeOf(name),
      size: info.size,
      offset,
      data: buffer.subarray(0, bytesRead).toString("base64"),
    }
  } finally {
    await file.close()
  }
}

/** Answers one `/desk/files/*` request (`kind` from the route, query from the path). */
export async function filesRequest(
  kind: "find" | "list" | "read",
  requestPath: string,
  device?: string,
): Promise<{ status: number; body?: unknown }> {
  const mark = requestPath.indexOf("?")
  const query = new URLSearchParams(mark >= 0 ? requestPath.slice(mark + 1) : "")
  try {
    if (kind === "find") return { status: 200, body: { v: 1, ...(await findFolders(query.get("name"))) } }
    if (kind === "list") return { status: 200, body: { v: 1, ...(await listFolder(query.get("path"), device)) } }
    const number = (name: string, fallback: number) => {
      const value = query.get(name)
      if (value === null) return fallback
      if (!/^\d{1,12}$/.test(value)) throw new FilesError(400, "bad_range")
      return Number(value)
    }
    const offset = number("offset", 0)
    const limit = Math.min(Math.max(number("limit", FILE_CHUNK_BYTES), 1), FILE_CHUNK_BYTES)
    return { status: 200, body: { v: 1, ...(await readFilePiece(query.get("path"), { offset, limit }, device)) } }
  } catch (error) {
    if (error instanceof FilesError) return { status: error.status, body: { error: error.reason } }
    return { status: 404, body: { error: "unreadable" } }
  }
}

export * as DeskFiles from "./files"
