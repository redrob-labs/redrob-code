import { Auth } from "@/auth"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import {
  DEFAULT_IMAGE_MODEL,
  decodeImageDataUrl,
  decodeResponse,
  gatewayMessage,
  gatewayUrl,
  redrobKey,
} from "@/tool/image_generate"
import { SharedAccount } from "@redrob-code/core/shared-account"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError, UpstreamError } from "../errors"
import type { ExtensionCallPayload, McpAppCallPayload, McpAppResolvePayload } from "../groups/extensions"

/** The image extension's id as the desktop names it (Cowork's `openai-image-gen`). */
const IMAGE_EXTENSIONS = new Set(["openai-image-gen", "image-gen"])
const IMAGE_ACTIONS = new Set(["generate", "edit", "blend"])
const IMAGE_TIMEOUT_MS = 180_000
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
const MAX_REFERENCES = 4
const REFERENCE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
}

/** MCP Apps limits, as Cowork's mcp-app-host had them. */
const MAX_APP_HTML_BYTES = 2 * 1024 * 1024
const APP_CALL_TIMEOUT_MS = 120_000

/** `1536x1024` -> `3:2`, the aspect the gateway's image models take. */
function aspectOf(size: unknown): string | undefined {
  const match = typeof size === "string" ? /^(\d+)x(\d+)$/.exec(size.trim()) : null
  if (!match) return undefined
  const w = Number(match[1])
  const h = Number(match[2])
  if (!w || !h) return undefined
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  const d = gcd(w, h)
  return `${w / d}:${h / d}`
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message
  return String(error)
}

/** A reference image as a data URL: a `file://` path the desktop sent, or a data URL as is. */
async function referenceUrl(ref: string): Promise<string> {
  if (ref.startsWith("data:image/")) return ref
  const file = ref.startsWith("file://") ? ref.slice("file://".length) : ref
  const mime = REFERENCE_MIME[path.extname(file).toLowerCase()]
  if (!mime) throw new Error(`Not an image this engine can send: ${path.basename(file)}`)
  const bytes = await readFile(file)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_REFERENCE_BYTES)
    throw new Error(`${path.basename(file)} is empty or larger than 20 MB.`)
  return `data:${mime};base64,${bytes.toString("base64")}`
}

function imagePrompt(action: string, prompt: string, references: number): string {
  if (action === "edit") return `Edit the attached image. ${prompt}`
  if (action === "blend") return `Blend the ${references} attached images into one new image. ${prompt}`
  return prompt
}

export const extensionsHandlers = HttpApiBuilder.group(InstanceHttpApi, "extensions", (handlers) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const auth = yield* Auth.Service
    const mcp = yield* MCP.Service

    const image = Effect.fnUntraced(function* (action: string, args: Record<string, unknown>) {
      if (!IMAGE_ACTIONS.has(action)) return { ok: false, error: `Unknown image action: ${action}` }
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
      if (!prompt) return { ok: false, error: "Describe the image to make." }
      const refs = Array.isArray(args.images) ? args.images.filter((x): x is string => typeof x === "string") : []
      if (action === "edit" && refs.length !== 1) return { ok: false, error: "Edit takes exactly one image." }
      if (action === "blend" && refs.length < 2) return { ok: false, error: "Blend takes two or more images." }
      if (refs.length > MAX_REFERENCES) return { ok: false, error: `At most ${MAX_REFERENCES} reference images.` }

      const stored = yield* auth.get("redrob").pipe(Effect.orElseSucceed(() => undefined))
      const key = redrobKey(stored) ?? (yield* Effect.promise(() => SharedAccount.apiKey()))
      if (!key) return { ok: false, error: "Sign in to Redrob to make images: no Redrob API key is available." }

      const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : DEFAULT_IMAGE_MODEL
      const urls = yield* Effect.tryPromise({
        try: () => Promise.all(refs.map(referenceUrl)),
        catch: (error) => new Error(message(error)),
      })
      const text = imagePrompt(action, prompt, urls.length)
      const aspect = aspectOf(args.size)
      const request = yield* HttpClientRequest.post(`${gatewayUrl()}/chat/completions`).pipe(
        HttpClientRequest.bearerToken(key),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson({
          model,
          messages: [
            {
              role: "user",
              content: urls.length
                ? [{ type: "text", text }, ...urls.map((url) => ({ type: "image_url", image_url: { url } }))]
                : text,
            },
          ],
          modalities: ["image", "text"],
          ...(aspect ? { image_config: { aspect_ratio: aspect } } : {}),
        }),
      )
      const response = yield* http
        .execute(request)
        .pipe(Effect.timeoutOrElse({ duration: IMAGE_TIMEOUT_MS, orElse: () => Effect.fail(new Error("Image generation timed out.")) }))
      const body = yield* response.text
      if (response.status < 200 || response.status >= 300)
        return { ok: false, error: `The Redrob gateway answered ${response.status}: ${gatewayMessage(body)}` }
      const payload = yield* decodeResponse(body)
      const reply = payload.choices[0]?.message
      const picture = (reply?.images ?? []).map((item) => decodeImageDataUrl(item.image_url.url)).find(Boolean)
      if (!picture) {
        const said = reply?.content?.trim()
        return { ok: false, error: `${model} returned no image${said ? `. It said: ${said.slice(0, 500)}` : "."}` }
      }
      const costUsd = payload.redrob?.costUsd
      return {
        ok: true,
        result: {
          b64: Buffer.from(picture.bytes).toString("base64"),
          mime: picture.mime,
          model,
          ...(costUsd === undefined ? {} : { costUsd }),
        },
      }
    })

    const call = Effect.fn("ExtensionsHttpApi.call")(function* (ctx: {
      payload: Schema.Schema.Type<typeof ExtensionCallPayload>
    }) {
      const { extensionId, action, args } = ctx.payload
      if (!IMAGE_EXTENSIONS.has(extensionId)) return { ok: false, error: `Unknown extension: ${extensionId}` }
      return yield* image(action, args ?? {}).pipe(
        Effect.catch((error) => Effect.succeed({ ok: false, error: message(error) })),
      )
    })

    /** The connected client a host means: its exact name, its sanitised name, or the prefix of its tool names. */
    const client = Effect.fnUntraced(function* (server: string) {
      const clients = yield* mcp.clients()
      if (clients[server]) return { name: server, client: clients[server] }
      const names = Object.keys(clients)
      const exact = names.find((name) => McpCatalog.sanitize(name) === server)
      const prefixed = names.filter((name) => McpCatalog.sanitize(name).startsWith(`${server}_`))
      const name = exact ?? (prefixed.length === 1 ? prefixed[0] : undefined)
      if (!name)
        return yield* new InvalidRequestError({ message: `No connected MCP server named ${server}`, field: "server" })
      return { name, client: clients[name] }
    })

    const mcpAppResolve = Effect.fn("ExtensionsHttpApi.mcpAppResolve")(function* (ctx: {
      payload: Schema.Schema.Type<typeof McpAppResolvePayload>
    }) {
      const { uri } = ctx.payload
      if (!uri.startsWith("ui://"))
        return yield* new InvalidRequestError({ message: "An MCP App view is a ui:// resource.", field: "uri" })
      const { name } = yield* client(ctx.payload.server)
      const read = yield* mcp.readResource(name, uri)
      if (!read) return yield* new UpstreamError({ message: `${name} did not return ${uri}`, service: name })
      const item = read.contents.find((c) => c.uri === uri) ?? read.contents[0]
      if (!item) return yield* new UpstreamError({ message: `${name} returned ${uri} empty`, service: name })
      if (item.mimeType && !item.mimeType.startsWith("text/html"))
        return yield* new InvalidRequestError({ message: `${uri} is ${item.mimeType}, not an HTML view.`, field: "uri" })
      const html =
        "text" in item && typeof item.text === "string"
          ? item.text
          : "blob" in item && typeof item.blob === "string"
            ? Buffer.from(item.blob, "base64").toString("utf8")
            : ""
      if (!html) return yield* new UpstreamError({ message: `${name} returned ${uri} empty`, service: name })
      if (Buffer.byteLength(html) > MAX_APP_HTML_BYTES)
        return yield* new UpstreamError({ message: `${uri} is larger than 2 MB`, service: name })
      return { html, mimeType: item.mimeType, server: name }
    })

    const mcpAppCall = Effect.fn("ExtensionsHttpApi.mcpAppCall")(function* (ctx: {
      payload: Schema.Schema.Type<typeof McpAppCallPayload>
    }) {
      const target = yield* client(ctx.payload.server)
      const result: unknown = yield* Effect.tryPromise({
        try: () =>
          target.client.callTool({ name: ctx.payload.name, arguments: ctx.payload.arguments ?? {} }, undefined, {
            timeout: APP_CALL_TIMEOUT_MS,
          }),
        catch: (error) => new UpstreamError({ message: message(error), service: target.name }),
      })
      return result
    })

    return handlers.handle("call", call).handle("mcpAppResolve", mcpAppResolve).handle("mcpAppCall", mcpAppCall)
  }),
)
