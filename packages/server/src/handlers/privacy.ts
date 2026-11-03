import { Mask } from "@redrob-code/core/privacy/mask"
import { Privacy } from "@redrob-code/core/privacy/service"
import { LLM, Message } from "@redrob-code/llm"
import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { resolveModel } from "./chat-completion"

/** How long the local model may take to name entities before the regex tier answers alone. */
const MODEL_TIMEOUT = "15 seconds"

/**
 * `POST /api/privacy/mask`: the texts as a model outside this machine may see them. The regex tier
 * always runs; the configured local model runs too whatever the mode switch says, because the caller
 * asked for masking. A model that fails, is missing or is slow costs its tier, never the answer.
 */
const mask = Effect.fn("privacy.mask")(function* (texts: readonly string[]) {
  const privacy = yield* (yield* Privacy.Service).get()
  const vault = new Mask.Vault()
  let used: string | null = null
  if (privacy.model) {
    const answer = yield* Effect.gen(function* () {
      const local = yield* resolveModel(privacy.model!)
      return yield* LLM.generate(
        LLM.request({
          model: local,
          messages: [Message.user(Mask.ENTITY_PROMPT + texts.join("\n"))],
          tools: [],
          generation: { maxTokens: 512 },
        }),
      )
    }).pipe(Effect.timeout(MODEL_TIMEOUT), Effect.option)
    if (Option.isSome(answer)) {
      used = privacy.model
      for (const entity of Mask.parseEntities(answer.value.text)) vault.add(entity)
    }
  }
  const masked = texts.map((text) => vault.maskText(text))
  const entities = vault.entries().filter((entry) => masked.some((text) => text.includes(entry.placeholder)))
  return { mode: used ? ("model" as const) : ("regex" as const), model: used, texts: masked, entities }
})

export const PrivacyHandler = HttpApiBuilder.group(Api, "server.privacy", (handlers) =>
  handlers
    .handle(
      "privacy.get",
      Effect.fn(function* () {
        return yield* (yield* Privacy.Service).get()
      }),
    )
    .handle(
      "privacy.set",
      Effect.fn(function* (ctx) {
        return yield* (yield* Privacy.Service).set(ctx.payload).pipe(Effect.orDie)
      }),
    )
    .handle(
      "privacy.mask",
      Effect.fn(function* (ctx) {
        return yield* mask(ctx.payload.texts)
      }),
    ),
)
