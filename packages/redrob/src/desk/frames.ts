/**
 * The Redrob Design relay wire protocol, version 1, as the chat API serves it
 * (redrob-chat `apps/api/src/design/relay/frames.ts`). Kept byte-for-byte compatible; the relay
 * only reads the header, never the payload.
 *
 *   control frames: JSON text  {"v":1,"type":"hello"|"welcome"|"leave","senderId":..,"targetId"?:..}
 *   action frames:  binary     [u8 version][u32 BE header length][header JSON][payload]
 *                              header = {"senderId":..,"targetId"?:..,"namespace":..}
 */
export const RELAY_PROTOCOL_VERSION = 1
export const MAX_RELAY_FRAME_BYTES = 8 * 1024 * 1024
const HEADER_PREFIX_BYTES = 5
/** A header is three short strings. Anything bigger is not a header. */
const MAX_HEADER_BYTES = 4096

export type ControlFrame = {
  readonly kind: "control"
  readonly type: "hello" | "welcome" | "leave"
  readonly senderId: string
  readonly targetId?: string
}

export type ActionFrame = {
  readonly kind: "action"
  readonly senderId: string
  readonly targetId?: string
  readonly namespace: string
  readonly payload: Uint8Array
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string"
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function decodeControl(text: string): ControlFrame | null {
  if (text.length > MAX_HEADER_BYTES) return null
  const value = parse(text)
  if (!record(value) || value.v !== RELAY_PROTOCOL_VERSION) return null
  const { type, senderId, targetId } = value
  if (type !== "hello" && type !== "welcome" && type !== "leave") return null
  if (typeof senderId !== "string" || !optionalString(targetId)) return null
  return targetId === undefined ? { kind: "control", type, senderId } : { kind: "control", type, senderId, targetId }
}

/** An action frame's header and its (opaque) payload. */
export function decodeAction(bytes: Uint8Array): ActionFrame | null {
  if (bytes.byteLength < HEADER_PREFIX_BYTES || bytes.byteLength > MAX_RELAY_FRAME_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint8(0) !== RELAY_PROTOCOL_VERSION) return null
  const headerLength = view.getUint32(1)
  if (headerLength > MAX_HEADER_BYTES) return null
  const end = HEADER_PREFIX_BYTES + headerLength
  if (end > bytes.byteLength) return null
  const header = parse(new TextDecoder().decode(bytes.subarray(HEADER_PREFIX_BYTES, end)))
  if (!record(header)) return null
  const { senderId, targetId, namespace } = header
  if (typeof senderId !== "string" || typeof namespace !== "string") return null
  if (!optionalString(targetId)) return null
  const payload = bytes.subarray(end)
  return targetId === undefined
    ? { kind: "action", senderId, namespace, payload }
    : { kind: "action", senderId, targetId, namespace, payload }
}

export function encodeControl(type: ControlFrame["type"], senderId: string, targetId?: string): string {
  return JSON.stringify(
    targetId === undefined
      ? { v: RELAY_PROTOCOL_VERSION, type, senderId }
      : { v: RELAY_PROTOCOL_VERSION, type, senderId, targetId },
  )
}

export function encodeAction(
  header: { senderId: string; targetId?: string; namespace: string },
  payload: Uint8Array,
): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header))
  const bytes = new Uint8Array(HEADER_PREFIX_BYTES + json.byteLength + payload.byteLength)
  const view = new DataView(bytes.buffer)
  view.setUint8(0, RELAY_PROTOCOL_VERSION)
  view.setUint32(1, json.byteLength)
  bytes.set(json, HEADER_PREFIX_BYTES)
  bytes.set(payload, HEADER_PREFIX_BYTES + json.byteLength)
  return bytes
}
