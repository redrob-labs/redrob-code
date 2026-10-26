/**
 * Desk relay crypto (redrob-mobile `docs/desk-relay.md`, section 3). WebCrypto only.
 *
 * - Keys are P-256. A public key on the wire is the 65-byte uncompressed point, base64url without
 *   padding. `deskId` / phone id = base64url(SHA-256(pub)).slice(0, 16).
 * - Per connection: `ikm = ECDH(Pe, De) || ECDH(P, D)` (raw x-coordinates),
 *   `salt = SHA-256(Pe_pub || De_pub)`, `info = "redrob-desk-v1"`, HKDF-SHA256 to 64 bytes:
 *   0..31 phone -> daemon, 32..63 daemon -> phone.
 * - AES-256-GCM, nonce = 4 zero bytes + u64 BE counter from 0 per direction, AAD = the sender's
 *   peerId as UTF-8. A frame is `[12-byte nonce][ciphertext + 16-byte tag]`.
 * - Pairing code = HKDF-SHA256(ECDH(P, D), salt = P_pub || D_pub, "redrob-desk-pair", 4 bytes) as
 *   u32 BE mod 1,000,000, six digits.
 */

const CURVE = { name: "ECDH", namedCurve: "P-256" } as const
const encoder = new TextEncoder()

function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

export function fromB64url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"))
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", ab(bytes)))
}

/** `base64url(SHA-256(pub)).slice(0, 16)`, for the desk id and a phone id alike. */
export async function keyId(pub: Uint8Array): Promise<string> {
  return b64url(await sha256(pub)).slice(0, 16)
}

export type KeyPair = { readonly privateKey: CryptoKey; readonly pub: Uint8Array }

export async function generate(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey(CURVE, true, ["deriveBits"])) as CryptoKeyPair
  return { privateKey: pair.privateKey, pub: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) }
}

/** The long-term key as stored: a private JWK (it carries the public point too). */
export async function exportPrivate(pair: KeyPair): Promise<string> {
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey))
}

export async function importPrivate(stored: string): Promise<KeyPair> {
  const jwk = JSON.parse(stored) as JsonWebKey
  const privateKey = await crypto.subtle.importKey("jwk", jwk, CURVE, true, ["deriveBits"])
  const publicKey = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, CURVE, true, [])
  return { privateKey, pub: new Uint8Array(await crypto.subtle.exportKey("raw", publicKey)) }
}

/** A peer's public key off the wire. Throws on anything that is not a P-256 point. */
export async function importPublic(pub: Uint8Array): Promise<CryptoKey> {
  if (pub.byteLength !== 65 || pub[0] !== 4) throw new Error("not an uncompressed P-256 point")
  return crypto.subtle.importKey("raw", ab(pub), CURVE, true, [])
}

async function ecdh(own: CryptoKey, peer: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: await importPublic(peer) }, own, 256))
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ab(ikm), "HKDF", false, ["deriveBits"])
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: ab(salt), info: ab(encoder.encode(info)) }, key, bytes * 8),
  )
}

/** The six-digit pairing code, daemon side: ECDH(D, P), salt P_pub || D_pub. */
export async function pairingCode(desk: KeyPair, phonePub: Uint8Array): Promise<string> {
  const bytes = await hkdf(await ecdh(desk.privateKey, phonePub), concat(phonePub, desk.pub), "redrob-desk-pair", 4)
  const value = new DataView(ab(bytes)).getUint32(0) % 1_000_000
  return String(value).padStart(6, "0")
}

function nonce(counter: bigint): Uint8Array {
  const out = new Uint8Array(12)
  new DataView(out.buffer).setBigUint64(4, counter)
  return out
}

/**
 * One encrypted phone <-> daemon session over one relay connection, daemon side. `open` returns
 * undefined for a replayed or out-of-order frame (dropped) and throws on a bad tag (the caller
 * closes the session).
 */
export class Channel {
  private sendCounter = 0n
  private lastReceived = -1n

  private constructor(
    private readonly sendKey: CryptoKey,
    private readonly receiveKey: CryptoKey,
    private readonly ownPeerId: string,
    private readonly phonePeerId: string,
  ) {}

  /**
   * Daemon side of the handshake: `De` is this connection's ephemeral key, `Pe_pub` and `P_pub`
   * came in `desk.hello`.
   */
  static async create(input: {
    desk: KeyPair
    ephemeral: KeyPair
    phonePub: Uint8Array
    phoneEph: Uint8Array
    ownPeerId: string
    phonePeerId: string
  }): Promise<Channel> {
    const ikm = concat(await ecdh(input.ephemeral.privateKey, input.phoneEph), await ecdh(input.desk.privateKey, input.phonePub))
    const salt = await sha256(concat(input.phoneEph, input.ephemeral.pub))
    const okm = await hkdf(ikm, salt, "redrob-desk-v1", 64)
    const key = (bytes: Uint8Array, usage: KeyUsage) => crypto.subtle.importKey("raw", ab(bytes), "AES-GCM", false, [usage])
    const phoneToDesk = await key(okm.subarray(0, 32), "decrypt")
    const deskToPhone = await key(okm.subarray(32, 64), "encrypt")
    return new Channel(deskToPhone, phoneToDesk, input.ownPeerId, input.phonePeerId)
  }

  async seal(plaintext: Uint8Array): Promise<Uint8Array> {
    const iv = nonce(this.sendCounter++)
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: ab(iv), additionalData: ab(encoder.encode(this.ownPeerId)) },
      this.sendKey,
      ab(plaintext),
    )
    return concat(iv, new Uint8Array(sealed))
  }

  async open(frame: Uint8Array): Promise<Uint8Array | undefined> {
    if (frame.byteLength < 12 + 16) throw new Error("short frame")
    const view = new DataView(frame.buffer, frame.byteOffset, 12)
    if (view.getUint32(0) !== 0) throw new Error("bad nonce")
    const counter = view.getBigUint64(4)
    if (counter <= this.lastReceived) return undefined
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ab(frame.subarray(0, 12)), additionalData: ab(encoder.encode(this.phonePeerId)) },
      this.receiveKey,
      ab(frame.subarray(12)),
    )
    this.lastReceived = counter
    return new Uint8Array(plain)
  }
}
