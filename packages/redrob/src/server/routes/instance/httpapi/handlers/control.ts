import { Auth } from "@/auth"

import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { LogInput, SpeechInput } from "../groups/control"
import { InvalidRequestError, ServiceUnavailableError, TimeoutError, UpstreamError } from "../errors"
import { PLAYBACK_DEFAULTS, prepareSpeech, requestSpeech, speechKey, type SpeechError } from "@/tool/speech_generate"
import { HttpClient } from "effect/unstable/http"
import { ProviderV2 } from "@redrob-code/core/provider"

export const controlHandlers = HttpApiBuilder.group(RootHttpApi, "control", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const http = yield* HttpClient.HttpClient

    /** Each failure as the endpoint declares it; no_key is 503 because the engine, not the caller, lacks it. */
    const speechFailure = (error: SpeechError) =>
      error.reason === "invalid"
        ? new InvalidRequestError({ message: error.message })
        : error.reason === "no_key"
          ? new ServiceUnavailableError({ message: error.message, service: "redrob" })
          : error.reason === "timeout"
            ? new TimeoutError({ message: error.message, operation: "speech" })
            : new UpstreamError({
                message: error.message,
                service: "redrob",
                ...(error.status ? { status: error.status } : {}),
              })

    const speech = Effect.fn("ControlHttpApi.speech")(function* (ctx: { payload: typeof SpeechInput.Type }) {
      // This route is for audio that is played at once, so it defaults to the fast playback model.
      const prepared = yield* prepareSpeech(ctx.payload, PLAYBACK_DEFAULTS)
      const key = yield* speechKey(auth)
      return (yield* requestSpeech(http, key, prepared)).audio
    }, Effect.mapError(speechFailure))

    const authSet = Effect.fn("ControlHttpApi.authSet")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: Auth.Info
    }) {
      yield* auth.set(ctx.params.providerID, ctx.payload).pipe(Effect.orDie)
      return true
    })

    const authRemove = Effect.fn("ControlHttpApi.authRemove")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
    }) {
      yield* auth.remove(ctx.params.providerID).pipe(Effect.orDie)
      return true
    })

    const log = Effect.fn("ControlHttpApi.log")(function* (ctx: { payload: typeof LogInput.Type }) {
      const write =
        ctx.payload.level === "debug"
          ? Effect.logDebug
          : ctx.payload.level === "info"
            ? Effect.logInfo
            : ctx.payload.level === "warn"
              ? Effect.logWarning
              : Effect.logError
      yield* write(ctx.payload.message).pipe(Effect.annotateLogs(ctx.payload.extra ?? {}))
      return true
    })

    return handlers
      .handle("authSet", authSet)
      .handle("authRemove", authRemove)
      .handle("speech", speech)
      .handle("log", log)
  }),
)
