export * as Privacy from "./service"

import fs from "fs/promises"
import path from "path"
import { Context, Effect, Layer, Ref } from "effect"
import { applyEdits, modify } from "jsonc-parser"
import { Config } from "../config"
import { ConfigPrivacy } from "../config/privacy"
import { makeLocationNode } from "../effect/app-node"
import { Global } from "../global"
import { Mask } from "./mask"

/**
 * The privacy switch an app flips: what `mask_pii` is right now, and how to change it.
 *
 * Config documents are read once when a location opens, so a value written to the file alone would
 * take effect on the next restart. This holds the live value too: `set` changes it for the next
 * message AND writes it to the user's global `redrob.json`, so it survives a restart and shows up in
 * every location on this machine. One engine, one switch, every app that runs on it.
 */
export interface Interface {
  readonly get: () => Effect.Effect<Mask.Settings>
  readonly set: (settings: Mask.Settings) => Effect.Effect<Mask.Settings, Error>
}

export class Error extends globalThis.Error {
  readonly _tag = "PrivacyWriteError"
}

export class Service extends Context.Service<Service, Interface>()("@redrob/v2/Privacy") {}

/**
 * The value last set in this process. Location services are built per directory (and the v1 session
 * runtime keeps its own location map), so a per-location Ref alone would leave every other location
 * on the value it read at boot. The switch is machine-wide, so once it is flipped every location reads it.
 */
let live: Mask.Settings | undefined

/** The value set in this process, if any: what a caller that reads config itself must prefer. */
export const current = (): Mask.Settings | undefined => live

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const global = yield* Global.Service
    const documents = (yield* config.entries()).filter((entry): entry is Config.Document => entry.type === "document")
    const current = yield* Ref.make(Mask.settings(documents))
    const file = path.join(global.config, "redrob.json")

    const write = (settings: Mask.Settings) =>
      Effect.tryPromise({
        try: async () => {
          const text = await fs.readFile(file, "utf8").catch(() => "{}")
          const value: ConfigPrivacy.Info = { mask_pii: settings.mode, model: settings.model }
          const edits = modify(text, ["privacy"], value, { formattingOptions: { tabSize: 2, insertSpaces: true } })
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.writeFile(file, applyEdits(text, edits))
        },
        catch: (cause) =>
          new Error(`Could not write ${file}: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`),
      })

    return Service.of({
      get: () => (live ? Effect.succeed(live) : Ref.get(current)),
      set: Effect.fn("Privacy.set")(function* (settings) {
        const next: Mask.Settings = { mode: settings.mode, model: settings.model?.trim() || undefined }
        yield* write(next)
        yield* Ref.set(current, next)
        live = next
        return next
      }),
    })
  }),
)

/** Test seam: a fixed setting, no file. */
export const layerWith = (settings: Mask.Settings) =>
  Layer.succeed(Service, Service.of({ get: () => Effect.succeed(settings), set: (next) => Effect.succeed(next) }))

export const node = makeLocationNode({ service: Service, layer, deps: () => [Config.node, Global.node] })
