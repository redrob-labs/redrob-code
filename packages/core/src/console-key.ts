export * as ConsoleKey from "./console-key"

import { join } from "node:path"
import { Effect } from "effect"

import { Global } from "./global"
import { Integration } from "./integration"
import { SharedAccount } from "./shared-account"

/**
 * The console API key, from wherever the user actually put it.
 *
 * FOUR ORIGINS, and they are not interchangeable historically:
 *
 *   - `REDROB_API_KEY` is what a terminal user exports.
 *   - The Credential store is what `redrob providers login` writes. It is SQL.
 *   - `auth.json` is what `PUT /auth/redrob` writes, which is the route the DESKTOP APP uses for both of
 *     its connect paths -- the pasted key and "Connect Redrob". That flow ends by handing the key to this
 *     same route, so the app never populates the Credential store at all.
 *   - Redrob Launcher's shared `account.json` is what the launcher writes when it signs the whole computer
 *     in. It is read-only here and it is the LAST fallback: any key of our own wins over it, and deleting
 *     `auth.json` leaves it alone, so a disconnect falls back to it rather than deleting it.
 *
 * Nothing bridges the middle two: one is SQL, the other a file, and no migration copies either into the
 * other. So every consumer has to read all four.
 *
 * This lives in its own module because reading only some of them is a bug that has already shipped once:
 * the dynamic model catalogue checked the environment and the Credential store, so a user who connected
 * through the desktop app had a key present, in `auth.json`, that the catalogue could not see -- it took
 * the keyless branch and silently served the six-id fallback list. A second consumer re-deriving this
 * logic is how that happens again, so there is one implementation and both callers use it.
 *
 * Note the SHAPES differ as well as the locations: the Credential store discriminates on `type: "key"`,
 * `auth.json` on `type: "api"`. Matching only one spelling was the second half of that same bug.
 */

/** `auth.json`, the desktop app's store. Absent or malformed reads as "no key" rather than failing. */
function fromAuthStore(): Effect.Effect<string | undefined> {
  return Effect.tryPromise(() => Bun.file(join(Global.Path.data, "auth.json")).json()).pipe(
    Effect.map((data) => {
      if (typeof data !== "object" || data === null) return undefined
      const entry = (data as Record<string, unknown>)["redrob"]
      if (typeof entry !== "object" || entry === null) return undefined
      const record = entry as Record<string, unknown>
      if (record["type"] !== "api") return undefined
      const key = record["key"]
      return typeof key === "string" && key.trim() ? key : undefined
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

/**
 * Where a resolved key came from. These are the `source` values the provider report exposes for the
 * `redrob` provider, so a host app can say "Signed in with Redrob Launcher" without ever seeing the key:
 * `env` is `REDROB_API_KEY`, `credential` the SQL store, `api` the engine's own `auth.json`, and
 * `launcher` the shared file.
 */
export type Source = "env" | "credential" | "api" | "launcher"

export interface Resolved {
  readonly key: string
  readonly source: Source
}

const found = (key: string, source: Source): Resolved => ({ key, source })

/**
 * Resolve the key and say where it came from, in the order a user would expect to win.
 *
 * The environment first, because an explicitly exported value is the one a person set most recently and
 * most deliberately -- overriding a stored credential for one run is a thing people do, and the reverse
 * would make that impossible. The launcher's shared file last, because it is not ours: it is the sign-in
 * for the whole computer, and anything this app holds itself is the more specific choice.
 */
export const resolveWithSource = Effect.fn("ConsoleKey.resolveWithSource")(function* () {
  const fromEnv = process.env["REDROB_API_KEY"]
  if (fromEnv) return found(fromEnv, "env")

  /*
    Read through `Integration`, not `Credential` directly. Both reach the same store, but `Credential` is not
    in scope everywhere this runs -- the HTTP handlers have `Integration` and resolving through it returns
    the same material. Using the lower-level service typechecked and then failed at request time with
    "Service not found", which is the kind of error a type system cannot catch for you.
  */
  const integration = yield* Integration.Service
  const connection = yield* integration.connection.active(Integration.ID.make("redrob"))
  if (connection) {
    const value = yield* integration.connection
      .resolve(connection)
      .pipe(Effect.orElseSucceed(() => undefined))
    if (value?.type === "key" && value.key.trim()) return found(value.key, "credential")
  }

  const fromFile = yield* fromAuthStore()
  if (fromFile) return found(fromFile, "api")

  // Read fresh every time, per the contract: the person may sign in or out of the launcher while we run.
  const shared = yield* Effect.promise(() => SharedAccount.apiKey())
  if (shared) return found(shared, "launcher")

  return undefined
})

/** The key alone, for callers that only need to spend it. */
export const resolve = Effect.fn("ConsoleKey.resolve")(function* () {
  const resolved = yield* resolveWithSource()
  return resolved?.key
})
