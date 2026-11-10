/**
 * The chat's skills for a session (code-work design 8.2). Session create may carry
 *
 *   skills: [{ name, scope: "user" | "org", contentSha256, files?: [{ path, content }] }]
 *
 * and the desk writes them to `<state>/directories/<key of the work folder>/skills/<session id>/`,
 * the per-directory folder outside the project tree that the engine reads skills from
 * (ConfigPaths.directoryConfigDir). Nothing lands in the repository, and the folder goes when the
 * session is deleted (`session.deleted`), or at the next start for a session that is gone.
 *
 * A skill whose `contentSha256` this desk already holds may come without `files`: the chat sends a
 * skill's files once per desk run (`GET /desk/skills` lists what it holds). One it does not hold,
 * sent without files, fails the create with 409 `{ missingSkills: [sha] }` before anything is made.
 *
 * Skill text is someone else's instructions: it ranks below the person and the safety rules, and
 * the approval rules still decide what runs (design 7).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { ConfigPaths } from "@/config/paths"
import { deskDir } from "./files"

const MAX_SKILLS = 100
const MAX_FILES = 200
const MAX_SKILL_BYTES = 2 * 1024 * 1024
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/
const SHA = /^[0-9a-f]{64}$/

export type SkillFile = { readonly path: string; readonly content: string }
export type PushedSkill = {
  readonly name: string
  readonly scope: "user" | "org"
  readonly contentSha256: string
  readonly files?: readonly SkillFile[]
}

export class SkillsError extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly body: Record<string, unknown>,
  ) {
    super(JSON.stringify(body))
  }
}

const manifestPath = () => path.join(deskDir(), "skills.json")

/** A relative file path made of plain segments, nothing that climbs or hides. */
function safeFile(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false
  const parts = value.split("/")
  return parts.length <= 8 && parts.every((part) => SEGMENT.test(part))
}

/** The `skills` field of a create body, checked; throws 400 for anything malformed. */
export function parseSkills(value: unknown): PushedSkill[] {
  if (value === undefined) return []
  const bad = (reason: string) => new SkillsError(400, { reason })
  if (!Array.isArray(value) || value.length > MAX_SKILLS) throw bad("skills")
  const names = new Set<string>()
  return value.map((item): PushedSkill => {
    if (typeof item !== "object" || item === null) throw bad("skill")
    const { name, scope, contentSha256, files } = item as Record<string, unknown>
    if (typeof name !== "string" || !NAME.test(name)) throw bad("skill name")
    if (scope !== "user" && scope !== "org") throw bad("skill scope")
    if (typeof contentSha256 !== "string" || !SHA.test(contentSha256)) throw bad("contentSha256")
    // The same name from two scopes: both are kept, side by side (design 8.1, nothing overwrites).
    const key = `${scope}/${name}`
    if (names.has(key)) throw bad("duplicate skill")
    names.add(key)
    if (files === undefined) return { name, scope, contentSha256 }
    if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) throw bad("skill files")
    let bytes = 0
    const seen = new Set<string>()
    const checked = files.map((file): SkillFile => {
      const { path: filePath, content } = (file ?? {}) as Record<string, unknown>
      if (!safeFile(filePath) || typeof content !== "string" || seen.has(filePath)) throw bad("skill file")
      seen.add(filePath)
      bytes += Buffer.byteLength(content)
      return { path: filePath, content }
    })
    if (bytes > MAX_SKILL_BYTES) throw bad("skill too large")
    if (!seen.has("SKILL.md")) throw bad("skill has no SKILL.md")
    return { name, scope, contentSha256, files: checked }
  })
}

export class SessionSkills {
  /** Skill files by content hash, for this desk run. */
  private readonly held = new Map<string, readonly SkillFile[]>()
  private manifest?: Promise<Record<string, string>>

  /** What this desk holds (`GET /desk/skills`). */
  list(): { contentSha256: string }[] {
    return [...this.held.keys()].map((contentSha256) => ({ contentSha256 }))
  }

  /** The hashes that came without files and are not held: the create cannot go on without them. */
  missing(skills: readonly PushedSkill[]): string[] {
    return skills.filter((skill) => !skill.files && !this.held.has(skill.contentSha256)).map((s) => s.contentSha256)
  }

  /** The session's folder for a work folder. */
  static folder(directory: string, sessionID: string): string {
    return path.join(ConfigPaths.directoryConfigDir(directory), "skills", sessionID)
  }

  private async load(): Promise<Record<string, string>> {
    this.manifest ??= readFile(manifestPath(), "utf8")
      .then((text) => {
        const value = JSON.parse(text) as unknown
        return typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, string>)
          : {}
      })
      .catch(() => ({}))
    return this.manifest
  }

  private async save(manifest: Record<string, string>): Promise<void> {
    await mkdir(deskDir(), { recursive: true })
    await writeFile(manifestPath(), JSON.stringify(manifest, null, 2), { mode: 0o600 })
  }

  /** Write a session's skills; returns the folder. Skills must not be `missing`. */
  async write(directory: string, sessionID: string, skills: readonly PushedSkill[]): Promise<string> {
    const folder = SessionSkills.folder(directory, sessionID)
    await rm(folder, { recursive: true, force: true })
    for (const skill of skills) {
      const files = skill.files ?? this.held.get(skill.contentSha256) ?? []
      if (skill.files) this.held.set(skill.contentSha256, skill.files)
      const dir = path.join(folder, `${skill.scope}-${skill.name}`)
      for (const file of files) {
        const target = path.join(dir, ...file.path.split("/"))
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, file.content, { mode: 0o600 })
      }
    }
    const manifest = await this.load()
    manifest[sessionID] = folder
    await this.save(manifest)
    return folder
  }

  /** The session ended: its folder goes. */
  async remove(sessionID: string): Promise<boolean> {
    const manifest = await this.load()
    const folder = manifest[sessionID]
    if (!folder) return false
    delete manifest[sessionID]
    await rm(folder, { recursive: true, force: true }).catch(() => undefined)
    await this.save(manifest)
    return true
  }

  /** At start: drop the folders of sessions that no longer exist. */
  async sweep(exists: (sessionID: string) => Promise<boolean>): Promise<void> {
    const manifest = await this.load()
    for (const sessionID of Object.keys(manifest)) {
      if (!(await exists(sessionID).catch(() => true))) await this.remove(sessionID)
    }
  }
}
