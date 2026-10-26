export * as ShareFileTool from "./share-file"

import path from "path"
import { stat } from "fs/promises"
import { ToolFailure } from "@redrob-code/llm"
import { SessionAttachment } from "@redrob-code/schema/session-attachment"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "share_file"
/** The largest file handed to the user. */
export const MAX_SHARE_BYTES = 10 * 1024 * 1024

/**
 * Files that are never handed over, whatever the permission rules say: env files (but not the
 * `.env.example` kind) and key or keystore files.
 */
const SECRET_FILES = [
  /^\.env$/i,
  /^\.env\..+$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p8$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.jks$/i,
  /\.keystore$/i,
  /^id_(rsa|ecdsa|ed25519|dsa)$/i,
]
const SAFE_EXAMPLES = /^\.env\.(example|sample|template)$/i

export const isSecretFile = (file: string) => {
  const base = path.basename(file)
  if (SAFE_EXAMPLES.test(base)) return false
  return SECRET_FILES.some((pattern) => pattern.test(base))
}

const Input = Schema.Struct({
  path: Schema.String.annotate({ description: "The file to send to the user" }),
  note: Schema.optional(Schema.String).annotate({ description: "A short line shown with the file" }),
})
const Output = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mime: Schema.String,
  size: Schema.Number,
  path: Schema.String,
})

const failure = (message: string) => new ToolFailure({ message })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service
    const events = yield* EventV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "사용자가 파일을 달라고 하면 이 도구로 보내요. 내용을 글로 옮기거나 OCR을 돌리지 마세요. " +
            `(Sends a file from this computer to the user's chat, up to ${MAX_SHARE_BYTES / (1024 * 1024)} MB. Env and key files are never sent.)`,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: `사용자에게 보냈어요: ${output.name}` }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              const target = yield* mutation
                .resolve({ path: input.path, kind: "directory" })
                .pipe(Effect.mapError(() => failure(`Unable to send ${input.path}`)))
              // Same rules as read: an outside folder asks, and the read ruleset decides the file.
              const external = target.externalDirectory
              if (external)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(external),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              if (isSecretFile(target.canonical))
                return yield* Effect.fail(
                  failure(`Not sent: ${path.basename(target.canonical)} looks like a secret file`),
                )
              yield* permission.assert({
                action: "read",
                resources: [target.resource],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              const info = yield* Effect.tryPromise(() => stat(target.canonical)).pipe(
                Effect.mapError(() => failure(`File not found: ${input.path}`)),
              )
              if (!info.isFile()) return yield* Effect.fail(failure(`Not a file: ${input.path}`))
              if (info.size > MAX_SHARE_BYTES)
                return yield* Effect.fail(
                  failure(`Not sent: ${path.basename(target.canonical)} is over ${MAX_SHARE_BYTES / (1024 * 1024)} MB`),
                )
              const attachment = {
                sessionID: context.sessionID,
                id: SessionAttachment.createID(),
                name: path.basename(target.canonical),
                mime: FSUtil.mimeType(target.canonical),
                size: info.size,
                source: "share" as const,
                path: target.canonical,
              }
              yield* events.publish(SessionAttachment.Event.Attached, attachment)
              return {
                id: attachment.id,
                name: attachment.name,
                mime: attachment.mime,
                size: attachment.size,
                path: attachment.path,
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : failure(error instanceof Error ? error.message : `Unable to send ${input.path}`),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/share-file",
  layer,
  deps: () => [ToolRegistry.node, LocationMutation.node, PermissionV2.node, EventV2.node],
})
