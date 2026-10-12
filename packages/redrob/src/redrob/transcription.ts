import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Auth } from "@/auth"
import { gatewayMessage, gatewayUrl, redrobKey } from "@/tool/image_generate"

/**
 * Transcription through the Redrob gateway's `POST /v1/audio/transcriptions`, on the engine's own
 * Redrob credential, for the reason speech gives: the key is the engine's and stays here. Its caller
 * is the engine's `POST /redrob/transcribe` route, which is how Redrob Cowork's push-to-talk turns a
 * recording into text without the app ever holding the key.
 *
 * Everything that can be refused is refused before anything is sent, so a bad request costs nothing.
 */

/** Scribe handles Korean, English and the two mixed in one sentence, which is how users speak. */
export const DEFAULT_TRANSCRIPTION_MODEL = "elevenlabs/scribe-v2"

/** The formats the gateway accepts, which are the ones its upstream documents. */
export const TRANSCRIPTION_FORMATS = ["wav", "mp3", "flac", "m4a", "ogg", "webm", "aac"] as const
export type TranscriptionFormat = (typeof TRANSCRIPTION_FORMATS)[number]

/** The gateway's limit for one request, decoded, checked here so an over-size clip costs nothing. */
export const MAX_TRANSCRIPTION_BYTES = 10 * 1024 * 1024

const TIMEOUT_MS = 120_000
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const LANGUAGE = /^[a-z]{2}$/

/**
 * Why audio could not be transcribed. `invalid` and `no_key` are found before anything is sent and
 * cost nothing; `upstream` and `timeout` are the gateway's.
 */
export class TranscriptionError extends Schema.TaggedErrorClass<TranscriptionError>()("TranscriptionError", {
  reason: Schema.Literals(["invalid", "no_key", "upstream", "timeout"]),
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

export type PreparedTranscription = {
  audio: string
  format: TranscriptionFormat
  model: string
  language?: string
  bytes: number
}

export type Transcript = { text: string; seconds?: number; costUsd?: number }

/** What base64 decodes to, without decoding it: three bytes per four characters, less the padding. */
function decodedBytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  return (base64.length / 4) * 3 - padding
}

/** The request as it will be sent, or why it would be refused, with nothing sent either way. */
export const prepare = Effect.fn("RedrobTranscription.prepare")(function* (input: {
  audio: string
  format: TranscriptionFormat
  model?: string
  language?: string
}) {
  const audio = input.audio.replace(/\s+/g, "")
  if (!audio) return yield* new TranscriptionError({ reason: "invalid", message: "Give the audio to transcribe." })
  if (audio.length % 4 !== 0 || !BASE64.test(audio)) {
    return yield* new TranscriptionError({
      reason: "invalid",
      message: "The audio must be base64: the raw bytes, not a data URL.",
    })
  }
  const bytes = decodedBytes(audio)
  if (bytes > MAX_TRANSCRIPTION_BYTES) {
    return yield* new TranscriptionError({
      reason: "invalid",
      message: `The audio is ${bytes} bytes; transcribe at most ${MAX_TRANSCRIPTION_BYTES} per call.`,
    })
  }
  const language = input.language?.trim().toLowerCase() || undefined
  if (language && !LANGUAGE.test(language)) {
    return yield* new TranscriptionError({
      reason: "invalid",
      message: `"${input.language}" is not an ISO-639-1 language such as "ko" or "en".`,
    })
  }
  const prepared: PreparedTranscription = {
    audio,
    format: input.format,
    model: input.model?.trim() || DEFAULT_TRANSCRIPTION_MODEL,
    ...(language ? { language } : {}),
    bytes,
  }
  return prepared
})

/** The engine's Redrob key, or a `no_key` failure, which is found before anything is sent. */
export const key = Effect.fn("RedrobTranscription.key")(function* (auth: Auth.Interface) {
  const found = redrobKey(yield* auth.get("redrob").pipe(Effect.orElseSucceed(() => undefined)))
  if (!found) {
    return yield* new TranscriptionError({
      reason: "no_key",
      message: "Connect Redrob to transcribe speech: no Redrob API key is available.",
    })
  }
  return found
})

const GatewayTranscript = Schema.Struct({
  text: Schema.String,
  seconds: Schema.optional(Schema.Number),
  costUsd: Schema.optional(Schema.Number),
})
const decodeTranscript = Schema.decodeUnknownEffect(Schema.fromJsonString(GatewayTranscript))

/** One call to the gateway. The answer is checked for being a transcript before anyone reads it. */
export const request = Effect.fn("RedrobTranscription.request")(function* (
  http: HttpClient.HttpClient,
  key: string,
  transcription: PreparedTranscription,
) {
  const outgoing = yield* HttpClientRequest.post(`${gatewayUrl()}/audio/transcriptions`).pipe(
    HttpClientRequest.bearerToken(key),
    HttpClientRequest.bodyJson({
      model: transcription.model,
      input_audio: { data: transcription.audio, format: transcription.format },
      response_format: "json",
      ...(transcription.language ? { language: transcription.language } : {}),
    }),
    Effect.orDie,
  )
  const response = yield* http.execute(outgoing).pipe(
    Effect.mapError(
      () => new TranscriptionError({ reason: "upstream", message: "The Redrob gateway could not be reached." }),
    ),
    Effect.timeoutOrElse({
      duration: TIMEOUT_MS,
      orElse: () => Effect.fail(new TranscriptionError({ reason: "timeout", message: "Transcription timed out." })),
    }),
  )
  const body = yield* response.text.pipe(
    Effect.mapError(
      () => new TranscriptionError({ reason: "upstream", message: "The Redrob gateway's answer was cut off." }),
    ),
  )
  if (response.status < 200 || response.status >= 300) {
    return yield* new TranscriptionError({
      reason: "upstream",
      status: response.status,
      message: `The Redrob gateway answered ${response.status}: ${gatewayMessage(body)}`,
    })
  }
  const parsed = yield* decodeTranscript(body).pipe(
    Effect.mapError(
      () => new TranscriptionError({ reason: "upstream", message: "The Redrob gateway answered without a transcript." }),
    ),
  )
  const transcript: Transcript = {
    text: parsed.text.trim(),
    ...(parsed.seconds !== undefined && Number.isFinite(parsed.seconds) ? { seconds: parsed.seconds } : {}),
    ...(parsed.costUsd !== undefined && Number.isFinite(parsed.costUsd) ? { costUsd: parsed.costUsd } : {}),
  }
  return transcript
})

export * as RedrobTranscription from "./transcription"
