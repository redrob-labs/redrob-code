#!/usr/bin/env bun

/**
 * Emits the JSON Schemas that the Console serves and that config files point at via `$schema`:
 *
 *   schema/config.json  <- ConfigV1.Info   ($id CONFIG_SCHEMA_URL, redrob.json / redrob.jsonc)
 *   schema/tui.json     <- TuiConfig.Info  ($id TUI_SCHEMA_URL,    tui.json)
 *   schema/theme.json   <- themeJsonSchema ($id THEME_SCHEMA_URL,  TUI theme files; hand-written,
 *                                            the theme format has no runtime schema)
 *
 *   bun run script/schema.ts            write all three into packages/redrob/schema/
 *   bun run check:generated             same, then `git diff --exit-code -- schema` (CI gate)
 *   bun run script/schema.ts <file>     legacy: write only the config schema to <file> (nix build)
 */

import path from "path"
import { fileURLToPath } from "url"
import { ConfigV1 } from "@redrob-code/core/v1/config/config"
import { CONFIG_SCHEMA_URL, THEME_SCHEMA_URL, TUI_SCHEMA_URL } from "@redrob-code/core/links"
import { TuiConfig } from "@redrob-code/tui/config"
import { themeJsonSchema } from "@redrob-code/tui/theme/schema"
import { Schema } from "effect"

type JsonSchema = Record<string, unknown>
const MODEL_REF = "https://models.dev/model-schema.json#/$defs/Model"
const OUT_DIR = fileURLToPath(new URL("../schema/", import.meta.url))

function generateEffect(schema: Schema.Top, id: string) {
  const document = Schema.toJsonSchemaDocument(schema)
  const normalized = normalize({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    ...document.schema,
    $defs: document.definitions,
  })
  if (!isRecord(normalized)) throw new Error("schema generator produced a non-object schema")
  const restored = restoreModelRefs(normalized)
  if (!isRecord(restored)) throw new Error("schema generator produced a non-object schema")
  const deduped = hoistRepeatedProperties(restored)
  deduped.allowComments = true
  deduped.allowTrailingCommas = true
  return deduped
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (!isRecord(value)) return value

  const schema = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]))

  if (Array.isArray(schema.anyOf)) {
    const anyOf = schema.anyOf.filter((item) => !isRecord(item) || item.type !== "null")
    if (anyOf.length !== schema.anyOf.length) {
      const { anyOf: _, ...rest } = schema
      if (anyOf.length === 1 && isRecord(anyOf[0])) return normalize({ ...anyOf[0], ...rest })
      return { ...rest, anyOf }
    }
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length === 1 && isRecord(schema.allOf[0])) {
    const { allOf: _, ...rest } = schema
    return normalize({ ...schema.allOf[0], ...rest })
  }

  if (schema.type === "integer" && schema.maximum === undefined) {
    return { ...schema, maximum: Number.MAX_SAFE_INTEGER }
  }

  return schema
}

function restoreModelRefs(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => restoreModelRefs(item))
  if (!isRecord(value)) return value

  const schema = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, restoreModelRefs(item, name)]))
  if ((key === "model" || key === "small_model") && schema.type === "string") {
    return { ...schema, $ref: MODEL_REF }
  }
  return schema
}

/**
 * `Schema.toJsonSchemaDocument` inlines a struct's field schema once per field. For a struct such as
 * `TuiKeybind` -- ~185 keys that all share one ~1.7KB value schema and differ only in `description`
 * -- that is a 1.1MB document. Whenever every property of an object (4 or more of them) has the same
 * schema once `description` is stripped, hoist that schema into `$defs/<Parent>Value` and leave a
 * `$ref` plus the per-key description behind. Pure restructuring: the accepted documents are identical.
 */
function hoistRepeatedProperties(root: JsonSchema): JsonSchema {
  const defs: JsonSchema = isRecord(root.$defs) ? { ...root.$defs } : {}

  const walk = (value: unknown, key: string): unknown => {
    if (Array.isArray(value)) return value.map((item) => walk(item, key))
    if (!isRecord(value)) return value
    const schema = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, walk(item, name)]))
    const props = schema.properties
    if (!isRecord(props)) return schema
    const entries = Object.entries(props)
    if (entries.length < 4) return schema
    const stripped = entries.map(([, item]) => {
      if (!isRecord(item)) return undefined
      const { description: _, ...rest } = item
      return JSON.stringify(rest)
    })
    const shape = stripped[0]
    if (!shape || shape.length < 200 || stripped.some((item) => item !== shape)) return schema
    const name = `${key.charAt(0).toUpperCase()}${key.slice(1)}Value`
    if (name in defs && JSON.stringify(defs[name]) !== shape) return schema
    defs[name] = JSON.parse(shape)
    return {
      ...schema,
      properties: Object.fromEntries(
        entries.map(([field, item]) => {
          const description = isRecord(item) ? item.description : undefined
          return [field, description === undefined ? { $ref: `#/$defs/${name}` } : { $ref: `#/$defs/${name}`, description }]
        }),
      ),
    }
  }

  const { $defs: _, ...rest } = root
  const walked = walk(rest, "")
  if (!isRecord(walked)) throw new Error("schema generator produced a non-object schema")
  return Object.keys(defs).length ? { ...walked, $defs: defs } : walked
}

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const render = (schema: JsonSchema) => `${JSON.stringify(schema, null, 2)}\n`

const outputs = {
  "config.json": () => generateEffect(ConfigV1.Info, CONFIG_SCHEMA_URL),
  "tui.json": () => generateEffect(TuiConfig.Info, TUI_SCHEMA_URL),
  "theme.json": () => themeJsonSchema(THEME_SCHEMA_URL),
}

const arg = process.argv[2]

if (arg) {
  // Legacy single-file mode (nix/redrob.nix): the config schema only, to the given path.
  console.log(arg)
  await Bun.write(arg, render(outputs["config.json"]()))
  // Keep the old optional second argument working.
  if (process.argv[3]) {
    console.log(process.argv[3])
    await Bun.write(process.argv[3], render(outputs["tui.json"]()))
  }
} else {
  for (const [name, build] of Object.entries(outputs)) {
    const file = path.join(OUT_DIR, name)
    console.log(path.relative(process.cwd(), file))
    await Bun.write(file, render(build()))
  }
}
