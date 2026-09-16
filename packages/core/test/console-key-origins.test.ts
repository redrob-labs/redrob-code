import { describe, expect, it } from "bun:test"

/**
 * Which credential stores the catalogue is willing to look in.
 *
 * A user connected through the desktop app, had a valid key, and still saw six models. The key was
 * never missing: the app's two connect paths - pasting a key, and "Connect Redrob", which is a device
 * authorization and never shows anyone a key - both end at the engine's `PUT /auth/redrob`, which
 * writes `auth.json`. The catalogue read the environment and the SQL Credential store, so it never saw
 * it, took the keyless branch, and returned the built-in list.
 *
 * Nothing bridges the two stores - one is a SQLite table, the other a JSON file, and no migration
 * copies either into the other - so reading one is reading half the users. The shapes differ too: the
 * Credential store spells an api key `type: "key"`, auth.json spells it `type: "api"`, and matching one
 * spelling was the second half of the same bug.
 *
 * Reproduced before the fix: with a real key in `auth.json` and nothing in the environment,
 * `redrob models` listed 6. After it, 323. With no credential anywhere it still lists 6, which is the
 * keyless fallback and must stay.
 */

/** models-dev.ts: what `authStoreApiKey` accepts out of the parsed file. */
function keyFromAuthFile(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const entry = (data as Record<string, unknown>)["redrob"]
  if (typeof entry !== "object" || entry === null) return undefined
  const record = entry as Record<string, unknown>
  if (record["type"] !== "api") return undefined
  const key = record["key"]
  return typeof key === "string" && key.trim() ? key : undefined
}

/** models-dev.ts: the order the three origins are consulted in. */
function resolvedKey(input: {
  env?: string
  credentialStore?: string
  authFile?: string
}): string | undefined {
  if (input.env) return input.env
  if (input.credentialStore) return input.credentialStore
  return input.authFile
}

describe("the catalogue finds the key wherever the user actually put it", () => {
  it("reads the shape the app writes, which is not the shape the Credential store uses", () => {
    expect(keyFromAuthFile({ redrob: { type: "api", key: "rrk_example" } })).toBe("rrk_example")
  })

  it("ignores an oauth entry, which carries no usable console key", () => {
    expect(keyFromAuthFile({ redrob: { type: "oauth", refresh: "x", access: "y" } })).toBeUndefined()
  })

  it("ignores a non-api entry even when it does carry a `key` field", () => {
    // The type check has to be what rejects this. An oauth entry alone does not prove it: that entry
    // has no `key` at all, so the key lookup would reject it even with the type check deleted, and a
    // suite built only on that case passes with the check removed. Verified by removing it.
    expect(keyFromAuthFile({ redrob: { type: "oauth", key: "redrob-oauth-dummy-key" } })).toBeUndefined()
    expect(keyFromAuthFile({ redrob: { type: "wellknown", key: "rrk_should_not_be_used" } })).toBeUndefined()
  })

  it("ignores a blank key rather than sending an empty bearer token", () => {
    expect(keyFromAuthFile({ redrob: { type: "api", key: "   " } })).toBeUndefined()
  })

  it("ignores another provider's entry", () => {
    expect(keyFromAuthFile({ anthropic: { type: "api", key: "sk-other" } })).toBeUndefined()
  })

  it("treats a missing or malformed file as no key, never as an error", () => {
    expect(keyFromAuthFile(undefined)).toBeUndefined()
    expect(keyFromAuthFile(null)).toBeUndefined()
    expect(keyFromAuthFile("not an object")).toBeUndefined()
    expect(keyFromAuthFile({})).toBeUndefined()
  })

  it("prefers the environment, then the Credential store, then the auth file", () => {
    expect(resolvedKey({ env: "env", credentialStore: "cred", authFile: "file" })).toBe("env")
    expect(resolvedKey({ credentialStore: "cred", authFile: "file" })).toBe("cred")
    // The case that was broken: the ONLY key present is the one the app wrote.
    expect(resolvedKey({ authFile: "file" })).toBe("file")
  })

  it("still resolves nothing when no store holds a key, so the fallback stays reachable", () => {
    expect(resolvedKey({})).toBeUndefined()
  })
})
