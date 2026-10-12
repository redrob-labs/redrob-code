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

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const global = yield* Global.Service
    const documents = (yield* config.entries()).filter(
      (entry): entry is Config.Document => entry.type === "document",
    )
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
        catch: (cause) => new Error(`Could not write ${file}: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`),
      })

    return Service.of({
      get: () => Ref.get(current),
      set: Effect.fn("Privacy.set")(function* (settings) {
        const next: Mask.Settings = { mode: settings.mode, model: settings.model?.trim() || undefined }
        yield* write(next)
        yield* Ref.set(current, next)
        return next
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: () => [Config.node, Global.node] })
