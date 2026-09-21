export * as ConsoleKey from "./console-key"

import { join } from "node:path"
import { Effect } from "effect"

import { Global } from "./global"
import { Integration } from "./integration"

/**
 * The console API key, from wherever the user actually put it.
 *
 * THREE ORIGINS, and they are not interchangeable historically:
 *
 *   - `REDROB_API_KEY` is what a terminal user exports.
 *   - The Credential store is what `redrob providers login` writes. It is SQL.
 *   - `auth.json` is what `PUT /auth/redrob` writes, which is the route the DESKTOP APP uses for both of
 *     its connect paths -- the pasted key and "Connect Redrob". That flow ends by handing the key to this
 *     same route, so the app never populates the Credential store at all.
 *
 * Nothing bridges the last two: one is SQL, the other a file, and no migration copies either into the
 * other. So every consumer has to read all three.
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
 * Resolve the key, in the order a user would expect to win.
 *
 * The environment first, because an explicitly exported value is the one a person set most recently and
 * most deliberately -- overriding a stored credential for one run is a thing people do, and the reverse
 * would make that impossible.
 */
export const resolve = Effect.fn("ConsoleKey.resolve")(function* () {
  const fromEnv = process.env["REDROB_API_KEY"]
  if (fromEnv) return fromEnv

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
    if (value?.type === "key" && value.key.trim()) return value.key
  }

  return yield* fromAuthStore()
})
