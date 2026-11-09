/**
 * The file panel's own edits (code-work design 10.1), answered by the forwarder:
 *
 *   GET  /desk/file/content?directory=&path=   -> { type: "text", content, hash } | { type: "binary", content (base64), hash }
 *   POST /desk/file/write   { directory?, path, content, encoding?: "utf8" | "base64", baseHash? } -> { hash }
 *   POST /desk/file/rename  { directory?, from, to }  -> { from, to }
 *   POST /desk/file/delete  { directory?, path }      -> { path }
 *
 * Only inside a session's work folder (roots.ts); `path` is relative to `directory`, or absolute
 * inside it. `hash` is the SHA-256 (hex) of the file's bytes. A write with `baseHash` checks the
 * file still has it and answers 409 `{ hash }` (null when the file is gone) when someone, the agent
 * say, changed it since the panel opened it; without `baseHash` the write goes through. Unlike the
 * engine's `GET /file/content`, the content here is not trimmed, so a save keeps the file's ending.
 * A `read_only` machine answers every POST 403 before this runs.
 */
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { RootError, queryOf, type Roots } from "./roots"

/** The largest file the panel opens or saves in one piece. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024

export type WriteOp = "content" | "write" | "rename" | "delete"

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

const HASH = /^[0-9a-f]{64}$/

type Result = { status: number; body?: unknown }

async function currentHash(file: string): Promise<string | null> {
  const info = await stat(file).catch(() => undefined)
  if (!info?.isFile()) return null
  return sha256(await readFile(file))
}

function record(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

/** Whether bytes decode as UTF-8 text (no NUL). */
function text(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

async function content(roots: Roots, requestPath: string): Promise<Result> {
  const query = queryOf(requestPath)
  const { file } = await roots.resolve(query.get("directory") ?? undefined, query.get("path") ?? "")
  const info = await stat(file).catch(() => undefined)
  if (!info?.isFile()) return { status: 404 }
  if (info.size > MAX_FILE_BYTES) return { status: 413, body: { size: info.size } }
  const bytes = await readFile(file)
  const hash = sha256(bytes)
  const decoded = text(bytes)
  return decoded !== undefined
    ? { status: 200, body: { type: "text", content: decoded, hash } }
    : { status: 200, body: { type: "binary", content: Buffer.from(bytes).toString("base64"), encoding: "base64", hash } }
}

/** Write through a temporary file in the same folder, so a reader never sees half a file. */
async function replace(file: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
  const mode = (await stat(file).catch(() => undefined))?.mode
  try {
    await writeFile(temporary, bytes, mode !== undefined ? { mode: mode & 0o777 } : {})
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function write(roots: Roots, body: Record<string, unknown>): Promise<Result> {
  const encoding = body.encoding ?? "utf8"
  if (typeof body.content !== "string" || (encoding !== "utf8" && encoding !== "base64")) return { status: 400 }
  if (body.baseHash !== undefined && body.baseHash !== null && (typeof body.baseHash !== "string" || !HASH.test(body.baseHash)))
    return { status: 400 }
  const { file } = await roots.resolve(body.directory, body.path)
  const bytes = encoding === "base64" ? Buffer.from(body.content, "base64") : Buffer.from(body.content, "utf8")
  if (bytes.byteLength > MAX_FILE_BYTES) return { status: 413 }
  const existing = await lstat(file).catch(() => undefined)
  if (existing?.isDirectory()) return { status: 409, body: { reason: "is_directory" } }
  if (typeof body.baseHash === "string" || body.baseHash === null) {
    const hash = await currentHash(file)
    if (hash !== body.baseHash) return { status: 409, body: { hash } }
  }
  await replace(file, bytes)
  return { status: 200, body: { hash: sha256(bytes) } }
}

async function move(roots: Roots, body: Record<string, unknown>): Promise<Result> {
  const from = await roots.resolve(body.directory, body.from)
  const to = await roots.resolve(body.directory ?? from.root, body.to)
  if (from.root !== to.root) throw new RootError(403, "outside_work_folder")
  if (!(await lstat(from.file).catch(() => undefined))) return { status: 404 }
  if (await lstat(to.file).catch(() => undefined)) return { status: 409, body: { reason: "exists" } }
  await mkdir(path.dirname(to.file), { recursive: true })
  await rename(from.file, to.file)
  return { status: 200, body: { from: from.file, to: to.file } }
}

async function remove(roots: Roots, body: Record<string, unknown>): Promise<Result> {
  const { file } = await roots.resolve(body.directory, body.path)
  if (!(await lstat(file).catch(() => undefined))) return { status: 404 }
  await rm(file, { recursive: true })
  return { status: 200, body: { path: file } }
}

/** One `/desk/file/*` call. */
export async function fileRequest(roots: Roots, op: WriteOp, requestPath: string, body: unknown): Promise<Result> {
  try {
    if (op === "content") return await content(roots, requestPath)
    const value = record(body)
    if (op === "write") return await write(roots, value)
    if (op === "rename") return await move(roots, value)
    return await remove(roots, value)
  } catch (error) {
    if (error instanceof RootError) return { status: error.status, body: { reason: error.reason } }
    const code = (error as { code?: unknown } | undefined)?.code
    if (code === "ENOENT") return { status: 404 }
    if (code === "EACCES" || code === "EPERM") return { status: 403, body: { reason: "permission" } }
    return { status: 500 }
  }
}
