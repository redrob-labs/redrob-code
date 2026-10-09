import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as path from "path"
import * as Tool from "./tool"
import DESCRIPTION from "./image_generate.txt"
import { Auth } from "@/auth"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { FileSystem } from "@redrob-code/core/filesystem"
import { Watcher } from "@redrob-code/core/filesystem/watcher"
import { FSUtil } from "@redrob-code/core/fs-util"
import { CONSOLE_URL } from "@redrob-code/core/plugin/provider/redrob-constants"
import { assertExternalDirectoryEffect } from "./external-directory"
import { sniffAttachmentMime } from "@/util/media"

/**
 * Image generation through the Redrob gateway, on the Redrob credential this engine already holds.
 *
 * A built-in rather than a plugin tool because the credential is the engine's: it lives in the auth
 * store (or `REDROB_API_KEY`), the desktop app never reads it, and no plugin API hands it out. Calling
 * the gateway from here keeps the key where it is and bills the image to the same account as the chat.
 *
 * The gateway relays an image model's pictures in OpenRouter's shape, `choices[0].message.images`,
 * when asked with `modalities: ["image", "text"]`. The picture is written under `artifacts/` and also
 * returned as an attachment, which is what puts it inline in the conversation and in front of the model.
 */

/** A good, mid-priced default. Any image-output model the gateway serves can be named instead. */
export const DEFAULT_IMAGE_MODEL = "google/gemini-2.5-flash-image"

/**
 * The gateway, read per call. `REDROB_CONSOLE_URL` is the same developer seam `CONSOLE_URL` honours
 * (never set in a shipped build); reading it here rather than only at module load is what lets a test
 * point one call at a stand-in without depending on which module loaded first.
 */
function gatewayUrl(): string {
  return (process.env["REDROB_CONSOLE_URL"] ?? CONSOLE_URL).replace(/\/+$/, "")
}

const TIMEOUT_MS = 180_000
/** A handful, which is what the image models take; each one is billed as image input. */
const MAX_REFERENCES = 4
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
}

export const Parameters = Schema.Struct({
  prompt: Schema.String.annotate({ description: "A full visual description of the image to generate" }),
  filename: Schema.optional(Schema.String).annotate({
    description: "Optional file name without an extension. Derived from the prompt when omitted.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: `Optional image model id served by the Redrob gateway. Defaults to ${DEFAULT_IMAGE_MODEL}.`,
  }),
  references: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: `Optional paths of up to ${MAX_REFERENCES} images in the project to edit or to use as a reference (PNG, JPEG, WebP, or GIF). To edit an image, pass it here and describe the change in the prompt.`,
  }),
})

const GatewayResponse = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({
        content: Schema.optional(Schema.NullOr(Schema.String)),
        images: Schema.optional(Schema.Array(Schema.Struct({ image_url: Schema.Struct({ url: Schema.String }) }))),
      }),
    }),
  ),
  redrob: Schema.optional(Schema.Struct({ costUsd: Schema.optional(Schema.Number) })),
})

const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(GatewayResponse))

/** The Redrob key: the engine's stored credential first, then the environment, as the provider resolves it. */
export function redrobKey(stored: Auth.Info | undefined): string | undefined {
  if (stored?.type === "api" && stored.key.trim()) return stored.key.trim()
  return process.env.REDROB_API_KEY?.trim() || undefined
}

/** A file-name stem from free text: lower case, ASCII letters and digits, at most 48 characters. */
export function slug(value: string): string {
  const stem = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "")
  return stem || "image"
}

/** A data URL's type and bytes, or undefined when it is not an inline image of a type we write. */
export function decodeImageDataUrl(url: string): { mime: string; bytes: Uint8Array } | undefined {
  const match = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url)
  if (!match) return undefined
  const mime = match[1].toLowerCase()
  if (!EXTENSIONS[mime]) return undefined
  const bytes = Uint8Array.from(Buffer.from(match[2], "base64"))
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return undefined
  return { mime, bytes }
}

export const ImageGenerateTool = Tool.define(
  "image_generate",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    const auth = yield* Auth.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service

    /**
     * The reference images, read and checked before anything is spent: in the project (or approved
     * outside it, as for any read), an image of a type the models take, and not too large to send.
     */
    const readReferences = Effect.fn("ImageGenerateTool.readReferences")(function* (
      paths: readonly string[],
      directory: string,
      ctx: Tool.Context,
    ) {
      if (paths.length > MAX_REFERENCES) throw new Error(`Pass at most ${MAX_REFERENCES} reference images.`)
      const references: { path: string; url: string }[] = []
      for (const given of paths) {
        const filepath = path.isAbsolute(given) ? given : path.join(directory, given)
        /* Asked before the file is opened, the same as any read outside the project. */
        yield* assertExternalDirectoryEffect(ctx, filepath)
        const bytes = yield* fs.readFile(filepath).pipe(Effect.orElseSucceed(() => undefined))
        if (!bytes) throw new Error(`Reference image not found: ${given}`)
        const mime = sniffAttachmentMime(bytes, "application/octet-stream")
        if (!EXTENSIONS[mime]) throw new Error(`Not a PNG, JPEG, WebP, or GIF image: ${given}`)
        if (bytes.byteLength > MAX_REFERENCE_BYTES) throw new Error(`Reference image is over 10 MB: ${given}`)
        references.push({ path: filepath, url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` })
      }
      return references
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const prompt = params.prompt.trim()
          if (!prompt) throw new Error("Describe the image to generate.")
          const key = redrobKey(yield* auth.get("redrob").pipe(Effect.orElseSucceed(() => undefined)))
          if (!key) throw new Error("Connect Redrob to generate images: no Redrob API key is available.")
          const model = params.model?.trim() || DEFAULT_IMAGE_MODEL

          const instance = yield* InstanceState.context
          const references = yield* readReferences(params.references ?? [], instance.directory, ctx)
          const directory = path.join(instance.directory, "artifacts")
          const stem = slug(params.filename?.trim() || prompt)

          /*
           * The path is chosen before anything is spent, so the request is refused for free where a file
           * cannot be written. Asked as `edit`, like `write`, because writing a file is what this does:
           * plan mode, which denies edits, denies this too.
           */
          const extension = "png"
          let filepath = path.join(directory, `${stem}.${extension}`)
          for (let n = 2; yield* fs.existsSafe(filepath); n += 1) {
            filepath = path.join(directory, `${stem}-${n}.${extension}`)
          }
          yield* assertExternalDirectoryEffect(ctx, filepath)
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: { filepath, prompt, model },
          })

          const request = yield* HttpClientRequest.post(`${gatewayUrl()}/chat/completions`).pipe(
            HttpClientRequest.bearerToken(key),
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyJson({
              model,
              /*
               * Text first, then the images, which is the order every vendor documents. A plain string
               * when there are none, so a text-only request is exactly what it was.
               */
              messages: [
                {
                  role: "user",
                  content: references.length
                    ? [
                        { type: "text", text: prompt },
                        ...references.map((reference) => ({ type: "image_url", image_url: { url: reference.url } })),
                      ]
                    : prompt,
                },
              ],
              modalities: ["image", "text"],
            }),
          )
          const response = yield* http.execute(request).pipe(
            Effect.timeoutOrElse({
              duration: TIMEOUT_MS,
              orElse: () => Effect.die(new Error("Image generation timed out")),
            }),
          )
          const body = yield* response.text
          if (response.status < 200 || response.status >= 300) {
            throw new Error(`The Redrob gateway answered ${response.status}: ${gatewayMessage(body)}`)
          }
          const payload = yield* decodeResponse(body)
          const message = payload.choices[0]?.message
          const image = (message?.images ?? []).map((item) => decodeImageDataUrl(item.image_url.url)).find(Boolean)
          if (!image) {
            const said = message?.content?.trim()
            throw new Error(`${model} returned no image${said ? `. It said: ${said.slice(0, 500)}` : "."}`)
          }

          /* A model that answered in another format keeps the chosen name with the right extension. */
          if (EXTENSIONS[image.mime] !== extension) {
            const base = filepath.slice(0, -extension.length - 1)
            filepath = `${base}.${EXTENSIONS[image.mime]}`
            for (let n = 2; yield* fs.existsSafe(filepath); n += 1) {
              filepath = `${base}-${n}.${EXTENSIONS[image.mime]}`
            }
          }
          yield* fs.writeWithDirs(filepath, image.bytes)
          yield* events.publish(FileSystem.Event.Edited, { file: filepath })
          yield* events.publish(Watcher.Event.Updated, { file: filepath, event: "add" })

          const relative = path.relative(instance.worktree, filepath)
          const costUsd = payload.redrob?.costUsd
          const caption = message?.content?.trim()
          return {
            title: relative,
            output: [`Generated ${relative} with ${model}.`, caption ? `The model said: ${caption}` : undefined]
              .filter(Boolean)
              .join("\n"),
            metadata: {
              filepath,
              model,
              ...(references.length ? { references: references.map((reference) => reference.path) } : {}),
              ...(costUsd === undefined ? {} : { costUsd }),
            },
            attachments: [
              {
                type: "file" as const,
                mime: image.mime,
                filename: path.basename(filepath),
                url: `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`,
              },
            ],
          }
        }).pipe(Effect.orDie),
    }
  }),
)

/** The gateway's error message, from OpenAI's envelope or Nest's, without echoing a whole body. */
function gatewayMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === "object") {
      const error = "error" in parsed ? parsed.error : undefined
      if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
        return error.message
      }
      if ("message" in parsed && typeof parsed.message === "string") return parsed.message
    }
  } catch {}
  return body.slice(0, 200) || "no details"
}
