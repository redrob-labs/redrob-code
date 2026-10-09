import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as path from "path"
import * as Tool from "./tool"
import DESCRIPTION from "./speech_generate.txt"
import { Auth } from "@/auth"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { FileSystem } from "@redrob-code/core/filesystem"
import { Watcher } from "@redrob-code/core/filesystem/watcher"
import { FSUtil } from "@redrob-code/core/fs-util"
import { assertExternalDirectoryEffect } from "./external-directory"
import { gatewayMessage, gatewayUrl, redrobKey, slug } from "./image_generate"

/**
 * Speech through the Redrob gateway's `POST /v1/audio/speech`, on the engine's own Redrob credential,
 * for the reason image_generate gives: the key is the engine's and stays here.
 *
 * The audio is saved and NOT returned as an attachment. An attachment goes back to the model with the
 * next turn, and audio input would steer `auto` to an audio-input model and bill the clip as input on
 * every turn after, to tell the model nothing it does not already know: it wrote the words.
 */

/** Multilingual, so a Korean script is spoken as Korean. Any speech model the gateway serves can be named. */
export const DEFAULT_SPEECH_MODEL = "elevenlabs/eleven-multilingual-v2"
export const DEFAULT_SPEECH_VOICE = "sarah"

/** The gateway's limit for one request, checked here so an over-long request costs nothing. */
export const MAX_SPEECH_CHARACTERS = 4_096

const TIMEOUT_MS = 180_000
const MAX_AUDIO_BYTES = 50 * 1024 * 1024

export const Parameters = Schema.Struct({
  text: Schema.String.annotate({ description: `The words to speak, at most ${MAX_SPEECH_CHARACTERS} characters` }),
  voice: Schema.optional(Schema.String).annotate({
    description: `Optional voice of the chosen model. Defaults to ${DEFAULT_SPEECH_VOICE} with the default model.`,
  }),
  model: Schema.optional(Schema.String).annotate({
    description: `Optional speech model id served by the Redrob gateway. Defaults to ${DEFAULT_SPEECH_MODEL}.`,
  }),
  filename: Schema.optional(Schema.String).annotate({
    description: "Optional file name without an extension. Derived from the text when omitted.",
  }),
})

/** Characters as the gateway bills them: code points, so the limit here agrees with its limit there. */
function characters(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

export const SpeechGenerateTool = Tool.define(
  "speech_generate",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const auth = yield* Auth.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const text = params.text.trim()
          if (!text) throw new Error("Give the words to speak.")
          const length = characters(text)
          if (length > MAX_SPEECH_CHARACTERS) {
            throw new Error(
              `The text is ${length} characters; speak at most ${MAX_SPEECH_CHARACTERS} per call and save longer material in parts.`,
            )
          }
          const key = redrobKey(yield* auth.get("redrob").pipe(Effect.orElseSucceed(() => undefined)))
          if (!key) throw new Error("Connect Redrob to generate speech: no Redrob API key is available.")
          const model = params.model?.trim() || DEFAULT_SPEECH_MODEL
          const voice = params.voice?.trim() || (model === DEFAULT_SPEECH_MODEL ? DEFAULT_SPEECH_VOICE : undefined)

          const instance = yield* InstanceState.context
          const directory = path.join(instance.directory, "artifacts")
          const stem = slug(params.filename?.trim() || text)
          let filepath = path.join(directory, `${stem}.mp3`)
          for (let n = 2; yield* fs.existsSafe(filepath); n += 1) {
            filepath = path.join(directory, `${stem}-${n}.mp3`)
          }
          yield* assertExternalDirectoryEffect(ctx, filepath)
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: { filepath, model, voice },
          })

          const request = yield* HttpClientRequest.post(`${gatewayUrl()}/audio/speech`).pipe(
            HttpClientRequest.bearerToken(key),
            HttpClientRequest.bodyJson({
              model,
              input: text,
              response_format: "mp3",
              ...(voice ? { voice } : {}),
            }),
          )
          const response = yield* http.execute(request).pipe(
            Effect.timeoutOrElse({
              duration: TIMEOUT_MS,
              orElse: () => Effect.die(new Error("Speech generation timed out")),
            }),
          )
          if (response.status < 200 || response.status >= 300) {
            throw new Error(`The Redrob gateway answered ${response.status}: ${gatewayMessage(yield* response.text)}`)
          }
          const contentType = response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? ""
          if (!contentType.startsWith("audio/")) {
            throw new Error(`The Redrob gateway answered with ${contentType || "no content type"}, not audio.`)
          }
          const audio = new Uint8Array(yield* response.arrayBuffer)
          if (audio.byteLength === 0) throw new Error("The Redrob gateway returned no audio.")
          if (audio.byteLength > MAX_AUDIO_BYTES) throw new Error("The audio is over 50 MB.")

          yield* fs.writeWithDirs(filepath, audio)
          yield* events.publish(FileSystem.Event.Edited, { file: filepath })
          yield* events.publish(Watcher.Event.Updated, { file: filepath, event: "add" })

          const relative = path.relative(instance.worktree, filepath)
          const cost = Number(response.headers["x-redrob-cost-usd"])
          return {
            title: relative,
            output: `Saved ${relative}: ${length} characters spoken with ${model}${voice ? ` (${voice})` : ""}.`,
            metadata: {
              filepath,
              model,
              ...(voice ? { voice } : {}),
              characters: length,
              ...(Number.isFinite(cost) ? { costUsd: cost } : {}),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
