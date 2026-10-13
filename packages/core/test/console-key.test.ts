import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Credential } from "@redrob-code/core/credential"
import { AppNodeBuilder } from "@redrob-code/core/effect/app-node-builder"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { EventV2 } from "@redrob-code/core/event"
import { Global } from "@redrob-code/core/global"
import { Integration } from "@redrob-code/core/integration"
import { ConsoleKey } from "@redrob-code/core/console-key"
import { SharedAccount } from "@redrob-code/core/shared-account"
import { testEffect } from "./lib/effect"

/**
 * Redrob Launcher's shared `account.json` as the LAST fallback for the console key.
 *
 * Everything here points `REDROB_SHARED_DIR` at a scratch directory, so no test ever reads or writes
 * the real `~/.config/redrob-shared`. `auth.json` lives under `Global.Path.data`, which the preload has
 * already moved into a temp directory for the same reason.
 */

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventV2.node])))

const authPath = path.join(Global.Path.data, "auth.json")

let sharedDir: string
let savedEnvKey: string | undefined
let savedSharedDir: string | undefined

const sharedFile = () => path.join(sharedDir, SharedAccount.FILE)

const writeShared = (body: unknown) =>
  fs.writeFile(sharedFile(), typeof body === "string" ? body : JSON.stringify(body))

const launcherAccount = {
  apiKey: "rk_from_launcher",
  apiKeyName: "Redrob Launcher",
  accountName: "Acme",
  apiBaseUrl: "https://console.redrob.ai/api/backend/v1",
}

beforeEach(async () => {
  sharedDir = await fs.mkdtemp(path.join(os.tmpdir(), "redrob-shared-test-"))
  savedEnvKey = process.env["REDROB_API_KEY"]
  savedSharedDir = process.env[SharedAccount.DIR_ENV]
  delete process.env["REDROB_API_KEY"]
  process.env[SharedAccount.DIR_ENV] = sharedDir
  await fs.rm(authPath, { force: true })
})

afterEach(async () => {
  if (savedEnvKey === undefined) delete process.env["REDROB_API_KEY"]
  else process.env["REDROB_API_KEY"] = savedEnvKey
  if (savedSharedDir === undefined) delete process.env[SharedAccount.DIR_ENV]
  else process.env[SharedAccount.DIR_ENV] = savedSharedDir
  await fs.rm(authPath, { force: true })
  await fs.rm(sharedDir, { recursive: true, force: true })
})

describe("SharedAccount", () => {
  test("REDROB_SHARED_DIR replaces the directory, and the file name stays account.json", () => {
    expect(SharedAccount.directory()).toBe(sharedDir)
    expect(SharedAccount.file()).toBe(path.join(sharedDir, "account.json"))
  })

  test("a blank REDROB_SHARED_DIR is not an override", () => {
    process.env[SharedAccount.DIR_ENV] = "   "
    expect(SharedAccount.directory()).not.toBe("   ")
    expect(SharedAccount.directory().endsWith(process.platform === "win32" ? "Shared" : "redrob-shared")).toBe(true)
  })

  test("parses the launcher's shape and drops blanks", () => {
    expect(SharedAccount.parse(JSON.stringify(launcherAccount))).toEqual(launcherAccount)
    expect(SharedAccount.parse(JSON.stringify({ apiKey: "rk_x", accountName: "  " }))).toEqual({
      apiKey: "rk_x",
      apiKeyName: undefined,
      accountName: undefined,
      apiBaseUrl: undefined,
    })
  })

  test("an empty apiKey, a non-object, or unreadable JSON all mean not signed in", () => {
    expect(SharedAccount.parse(JSON.stringify({ apiKey: "" }))).toBeUndefined()
    expect(SharedAccount.parse(JSON.stringify({ apiKey: "   " }))).toBeUndefined()
    expect(SharedAccount.parse(JSON.stringify({ apiKeyName: "Redrob Launcher" }))).toBeUndefined()
    expect(SharedAccount.parse(JSON.stringify([launcherAccount]))).toBeUndefined()
    expect(SharedAccount.parse("null")).toBeUndefined()
    expect(SharedAccount.parse('"rk_not_an_object"')).toBeUndefined()
    expect(SharedAccount.parse("{ not json")).toBeUndefined()
    expect(SharedAccount.parse("")).toBeUndefined()
  })

  test("a missing file reads as not signed in rather than an error", async () => {
    expect(await SharedAccount.read()).toBeUndefined()
    expect(await SharedAccount.apiKey()).toBeUndefined()
  })

  test("reads the file fresh every time: a launcher sign-out is seen on the next read", async () => {
    await writeShared(launcherAccount)
    expect(await SharedAccount.apiKey()).toBe("rk_from_launcher")
    await fs.rm(sharedFile())
    expect(await SharedAccount.apiKey()).toBeUndefined()
    await writeShared({ ...launcherAccount, apiKey: "rk_second_sign_in" })
    expect(await SharedAccount.apiKey()).toBe("rk_second_sign_in")
  })
})

describe("ConsoleKey with the shared account as the last fallback", () => {
  it.effect("resolves nothing when no source holds a key", () =>
    Effect.gen(function* () {
      expect(yield* ConsoleKey.resolveWithSource()).toBeUndefined()
      expect(yield* ConsoleKey.resolve()).toBeUndefined()
    }),
  )

  it.effect("falls back to the launcher's shared file and says so", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeShared(launcherAccount))
      expect(yield* ConsoleKey.resolveWithSource()).toEqual({ key: "rk_from_launcher", source: "launcher" })
      expect(yield* ConsoleKey.resolve()).toBe("rk_from_launcher")
    }),
  )

  it.effect("REDROB_API_KEY wins over the shared file", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeShared(launcherAccount))
      process.env["REDROB_API_KEY"] = "rk_from_env"
      expect(yield* ConsoleKey.resolveWithSource()).toEqual({ key: "rk_from_env", source: "env" })
    }),
  )

  it.effect("the app's own auth.json wins over the shared file", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeShared(launcherAccount))
      yield* Effect.promise(() =>
        fs.writeFile(authPath, JSON.stringify({ redrob: { type: "api", key: "rk_from_auth_json" } })),
      )
      expect(yield* ConsoleKey.resolveWithSource()).toEqual({ key: "rk_from_auth_json", source: "api" })
    }),
  )

  it.effect("deleting auth.json leaves the shared file alone and falls back to it", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeShared(launcherAccount))
      yield* Effect.promise(() =>
        fs.writeFile(authPath, JSON.stringify({ redrob: { type: "api", key: "rk_from_auth_json" } })),
      )
      expect((yield* ConsoleKey.resolveWithSource())?.source).toBe("api")
      // What `DELETE /auth/redrob` does to the engine's own store. The shared file is not ours to touch.
      yield* Effect.promise(() => fs.rm(authPath))
      expect(yield* ConsoleKey.resolveWithSource()).toEqual({ key: "rk_from_launcher", source: "launcher" })
      expect(yield* Effect.promise(() => fs.readFile(sharedFile(), "utf8"))).toBe(JSON.stringify(launcherAccount))
    }),
  )

  it.effect("a malformed or empty shared file is not signed in", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeShared("{ half a file"))
      expect(yield* ConsoleKey.resolveWithSource()).toBeUndefined()
      yield* Effect.promise(() => writeShared({ apiKey: "" }))
      expect(yield* ConsoleKey.resolveWithSource()).toBeUndefined()
      yield* Effect.promise(() => writeShared(""))
      expect(yield* ConsoleKey.resolveWithSource()).toBeUndefined()
    }),
  )

  it.effect("a file removed between two resolves is seen as gone: nothing is cached", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeShared(launcherAccount))
      expect((yield* ConsoleKey.resolveWithSource())?.source).toBe("launcher")
      yield* Effect.promise(() => fs.rm(sharedFile()))
      expect(yield* ConsoleKey.resolveWithSource()).toBeUndefined()
    }),
  )
})
