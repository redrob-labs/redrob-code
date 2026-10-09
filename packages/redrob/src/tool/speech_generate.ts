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
 * Two callers share `prepareSpeech` and `requestSpeech`: the `speech_generate` tool, which saves an
 * mp3, and the engine's `POST /redrob/speech` route, which hands the audio to Redrob Cowork to play
 * a reply aloud without the app ever holding the key.
 *
 * The tool saves its audio and does NOT return it as an attachment. An attachment goes back to the
 * model with the next turn, and audio input would steer `auto` to an audio-input model and bill the
 * clip as input on every turn after, to tell the model nothing it does not already know: it wrote
 * the words.
 */

/** Multilingual, so a Korean script is spoken as Korean. Any speech model the gateway serves can be named. */
export const DEFAULT_SPEECH_MODEL = "elevenlabs/eleven-multilingual-v2"
export const DEFAULT_SPEECH_VOICE = "sarah"

/** The gateway's limit for one request, checked here so an over-long request costs nothing. */
export const MAX_SPEECH_CHARACTERS = 4_096

const TIMEOUT_MS = 180_000
const MAX_AUDIO_BYTES = 50 * 1024 * 1024

/**
 * Why speech could not be made. `invalid` and `no_key` are found before anything is sent and cost
 * nothing; `upstream` and `timeout` are the gateway's.
 */
export class SpeechError extends Schema.TaggedErrorClass<SpeechError>()("SpeechError", {
  reason: Schema.Literals(["invalid", "no_key", "upstream", "timeout"]),
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

export type PreparedSpeech = { text: string; model: string; voice?: string; characters: number }

/** Characters as the gateway bills them: code points, so the limit here agrees with its limit there. */
function characters(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** The request as it will be sent, or why it would be refused, with nothing sent either way. */
export const prepareSpeech = Effect.fn("Speech.prepare")(function* (input: {
  text: string
  model?: string
  voice?: string
}) {
  const text = input.text.trim()
  if (!text) return yield* new SpeechError({ reason: "invalid", message: "Give the words to speak." })
  const length = characters(text)
  if (length > MAX_SPEECH_CHARACTERS) {
    return yield* new SpeechError({
      reason: "invalid",
      message: `The text is ${length} characters; speak at most ${MAX_SPEECH_CHARACTERS} per call and save longer material in parts.`,
    })
  }
  const model = input.model?.trim() || DEFAULT_SPEECH_MODEL
  /* Voices belong to a model, so the default voice only goes with the default model. */
  const voice = input.voice?.trim() || (model === DEFAULT_SPEECH_MODEL ? DEFAULT_SPEECH_VOICE : undefined)
  const prepared: PreparedSpeech = { text, model, ...(voice ? { voice } : {}), characters: length }
  return prepared
})

/** The engine's Redrob key, or a `no_key` failure, which is found before anything is sent. */
export const speechKey = Effect.fn("Speech.key")(function* (auth: Auth.Interface) {
  const key = redrobKey(yield* auth.get("redrob").pipe(Effect.orElseSucceed(() => undefined)))
  if (!key) {
    return yield* new SpeechError({
      reason: "no_key",
      message: "Connect Redrob to generate speech: no Redrob API key is available.",
    })
  }
  return key
})

/** One call to the gateway. The audio is checked for being audio before anyone keeps or plays it. */
export const requestSpeech = Effect.fn("Speech.request")(function* (
  http: HttpClient.HttpClient,
  key: string,
  speech: PreparedSpeech,
) {
  const request = yield* HttpClientRequest.post(`${gatewayUrl()}/audio/speech`).pipe(
    HttpClientRequest.bearerToken(key),
    HttpClientRequest.bodyJson({
      model: speech.model,
      input: speech.text,
      response_format: "mp3",
      ...(speech.voice ? { voice: speech.voice } : {}),
    }),
    Effect.orDie,
  )
  const response = yield* http.execute(request).pipe(
    Effect.mapError(() => new SpeechError({ reason: "upstream", message: "The Redrob gateway could not be reached." })),
    Effect.timeoutOrElse({
      duration: TIMEOUT_MS,
      orElse: () => Effect.fail(new SpeechError({ reason: "timeout", message: "Speech generation timed out." })),
    }),
  )
  if (response.status < 200 || response.status >= 300) {
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
    return yield* new SpeechError({
      reason: "upstream",
      status: response.status,
      message: `The Redrob gateway answered ${response.status}: ${gatewayMessage(body)}`,
    })
  }
  const contentType = response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? ""
  if (!contentType.startsWith("audio/")) {
    return yield* new SpeechError({
      reason: "upstream",
      message: `The Redrob gateway answered with ${contentType || "no content type"}, not audio.`,
    })
  }
  const buffer = yield* response.arrayBuffer.pipe(
    Effect.mapError(() => new SpeechError({ reason: "upstream", message: "The Redrob gateway's audio was cut off." })),
  )
  const audio = new Uint8Array(buffer)
  if (audio.byteLength === 0) {
    return yield* new SpeechError({ reason: "upstream", message: "The Redrob gateway returned no audio." })
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    return yield* new SpeechError({ reason: "upstream", message: "The audio is over 50 MB." })
  }
  const cost = Number(response.headers["x-redrob-cost-usd"])
  return { audio, contentType, ...(Number.isFinite(cost) ? { costUsd: cost } : {}) }
})

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
          const speech = yield* prepareSpeech(params)
          const key = yield* speechKey(auth)

          const instance = yield* InstanceState.context
          const directory = path.join(instance.directory, "artifacts")
          const stem = slug(params.filename?.trim() || speech.text)
          let filepath = path.join(directory, `${stem}.mp3`)
          for (let n = 2; yield* fs.existsSafe(filepath); n += 1) {
            filepath = path.join(directory, `${stem}-${n}.mp3`)
          }
          yield* assertExternalDirectoryEffect(ctx, filepath)
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: { filepath, model: speech.model, voice: speech.voice },
          })

          const spoken = yield* requestSpeech(http, key, speech)
          yield* fs.writeWithDirs(filepath, spoken.audio)
          yield* events.publish(FileSystem.Event.Edited, { file: filepath })
          yield* events.publish(Watcher.Event.Updated, { file: filepath, event: "add" })

          const relative = path.relative(instance.worktree, filepath)
          return {
            title: relative,
            output: `Saved ${relative}: ${speech.characters} characters spoken with ${speech.model}${speech.voice ? ` (${speech.voice})` : ""}.`,
            metadata: {
              filepath,
              model: speech.model,
              ...(speech.voice ? { voice: speech.voice } : {}),
              characters: speech.characters,
              ...(spoken.costUsd === undefined ? {} : { costUsd: spoken.costUsd }),
            },
          }
        }).pipe(
          Effect.catchTag("SpeechError", (error) => Effect.die(new Error(error.message))),
          Effect.orDie,
        ),
    }
  }),
)
