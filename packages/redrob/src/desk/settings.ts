/**
 * The desk settings: `~/.redrob/desk/settings.json` (`%USERPROFILE%\.redrob\desk\settings.json` on
 * Windows). The Redrob Launcher writes it; the daemon writes only the `machine` entry, and only
 * from its own local API (`/desk/machine`). Phones, the web and the relay server cannot change it.
 * Read on every call, so a change applies without a restart.
 */
import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import path from "node:path"

export function settingsPath(): string {
  return path.join(homedir(), ".redrob", "desk", "settings.json")
}

async function readSettings(): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(settingsPath(), "utf8")) as unknown
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Writes are serialized and replace the file whole, so the launcher never reads half a file. */
let writing: Promise<unknown> = Promise.resolve()

function updateSettings<A>(change: (settings: Record<string, unknown>) => { settings: Record<string, unknown>; result: A }): Promise<A> {
  const run = writing.then(async () => {
    const { settings, result } = change(await readSettings())
    const file = settingsPath()
    await mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(settings, null, 2) + "\n", "utf8")
    await rename(temp, file)
    return result
  })
  writing = run.catch(() => undefined)
  return run
}

/**
 * Whether a device may pick Auto all. On unless the launcher's "Allow Auto all from phone and web"
 * switch was turned off (`allowAutoAll: false`). Missing or unreadable file: on.
 */
export async function allowAutoAll(): Promise<boolean> {
  return (await readSettings()).allowAutoAll !== false
}

export type MachineKind = "desktop" | "server" | "cloud"
export const MACHINE_KINDS: readonly MachineKind[] = ["desktop", "server", "cloud"]

/**
 * What phones and the web may do on this machine:
 *
 * - `read_only`: reads only; every POST is refused (403);
 * - `ask`: commands ask before they run; Auto all is lowered to `edits`;
 * - `trusted`: the device's approval mode applies as asked.
 */
export type MachineAccess = "read_only" | "ask" | "trusted"
export const MACHINE_ACCESS: readonly MachineAccess[] = ["read_only", "ask", "trusted"]

/** This machine as the relay and the devices see it. `id` is made once and never changes. */
export type Machine = {
  readonly id: string
  readonly name: string
  readonly kind: MachineKind
  /** `process.platform`, read live. */
  readonly os: string
  readonly access: MachineAccess
}

export type MachineUpdate = { readonly name?: string; readonly kind?: MachineKind; readonly access?: MachineAccess }

/** A name as stored: trimmed, at most 100 characters; undefined when empty. */
export function machineName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const name = value.trim().slice(0, 100)
  return name.length > 0 ? name : undefined
}

function storedMachine(settings: Record<string, unknown>): Record<string, unknown> {
  const value = settings.machine
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function toMachine(stored: Record<string, unknown>, id: string): Machine {
  return {
    id,
    name: machineName(stored.name) ?? hostname(),
    kind: MACHINE_KINDS.includes(stored.kind as MachineKind) ? (stored.kind as MachineKind) : "desktop",
    os: process.platform,
    access: MACHINE_ACCESS.includes(stored.access as MachineAccess) ? (stored.access as MachineAccess) : "trusted",
  }
}

const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)

/** This machine. The first call makes and stores its id. Name defaults to the hostname, kind to desktop, access to trusted. */
export async function machine(): Promise<Machine> {
  const settings = await readSettings()
  const stored = storedMachine(settings)
  if (validId(stored.id)) return toMachine(stored, stored.id)
  return updateSettings((current) => {
    const now = storedMachine(current)
    const id = validId(now.id) ? now.id : randomUUID()
    return { settings: { ...current, machine: { ...now, id } }, result: toMachine(now, id) }
  })
}

/** Rename this machine or change its kind or access. Fields left out keep their value. */
export async function updateMachine(update: MachineUpdate): Promise<Machine> {
  return updateSettings((current) => {
    const now = storedMachine(current)
    const id = validId(now.id) ? now.id : randomUUID()
    const name = update.name !== undefined ? machineName(update.name) : undefined
    const next = {
      ...now,
      id,
      ...(name ? { name } : {}),
      ...(update.kind && MACHINE_KINDS.includes(update.kind) ? { kind: update.kind } : {}),
      ...(update.access && MACHINE_ACCESS.includes(update.access) ? { access: update.access } : {}),
    }
    return { settings: { ...current, machine: next }, result: toMachine(next, id) }
  })
}

export function eventsPath(): string {
  return path.join(homedir(), ".redrob", "desk", "events.jsonl")
}

/** Append one line to `~/.redrob/desk/events.jsonl`, which the launcher reads to tell the person at the PC. */
export async function appendEvent(event: Record<string, unknown>): Promise<void> {
  const file = eventsPath()
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n", "utf8")
}
