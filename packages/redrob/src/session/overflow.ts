import type { Config } from "@/config/config"
import { ConfigV1 } from "@redrob-code/core/v1/config/config"
import { SessionV1 } from "@redrob-code/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

/**
 * Where compaction fires, as a percentage of the model's context window.
 *
 * 70 rather than "whatever is left after a 20,000-token reserve". That reserve was written for windows
 * measured in tens of thousands of tokens; against a 1,000,000-token model it puts the trigger at 98%,
 * which is late enough that the turn which crosses it is also the turn that fails. A percentage scales
 * with the window instead of shrinking as a fraction of it, and 70% leaves room for a long reply and a
 * summarisation pass without cutting the usable conversation short.
 */
const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 70

/**
 * The most one turn's INPUT may cost before compaction fires, in USD.
 *
 * The percentage above scales with the window. Money does not. Against a 1,000,000-token model at
 * $3.15 per million input tokens, 70% is 686,000 tokens, so a conversation is allowed to reach about
 * $2.16 of input on EVERY subsequent turn before anything is summarised, and the turns before that one
 * are not cheap either: a measured session sat at 384,000 tokens and was billed $1.21 per turn, with the
 * threshold still 300,000 tokens away.
 *
 * That is the failure the percentage was introduced to fix, seen from the other side. A fixed token
 * reserve was too late on a large window; a fixed percentage of a large window is too expensive on it.
 * The two limits answer different questions, so both apply and whichever comes first wins.
 *
 * $0.50 rather than a token count, because the number a user recognises is the one on their invoice, and
 * the token count that produces it differs by a factor of ten across models they switch between freely.
 * A model with no published input price is governed by the percentage alone.
 */
const DEFAULT_MAX_TURN_INPUT_COST_USD = 0.5

/**
 * The token count at which one turn's input reaches the cost ceiling, or undefined when it cannot be
 * priced.
 *
 * Uses the long-context rate once the conversation is past the tier that publishes one, since that is the
 * rate the next turn will actually be billed at. Pricing the ceiling at the cheap rate would place the
 * trigger past the point where the expensive rate has already been paid.
 */
function costCeilingTokens(input: {
  cfg: ConfigV1.Info
  model: Provider.Model
  tokens?: number
}): number | undefined {
  const budget = input.cfg.compaction?.maxTurnInputCostUsd ?? DEFAULT_MAX_TURN_INPUT_COST_USD
  if (budget <= 0) return undefined
  const over200K = input.model.cost?.experimentalOver200K
  const perMillion =
    over200K && (input.tokens ?? 0) > 200_000 ? over200K.input : input.model.cost?.input
  if (!perMillion || perMillion <= 0) return undefined
  return Math.floor((budget / perMillion) * 1_000_000)
}

export function usable(input: {
  cfg: ConfigV1.Info
  model: Provider.Model
  outputTokenMax?: number
  /** Tokens already in play, used only to pick the rate the NEXT turn will be billed at. */
  tokens?: number
}) {
  const context = input.model.limit.context
  if (context === 0) return 0

  /*
   * An explicit `reserved` still wins, because it is the older and more specific knob: a caller who set
   * a token budget meant that number and not a percentage of a window they may not know.
   */
  if (input.cfg.compaction?.reserved !== undefined) {
    // Truthy, for the same reason as below: a published 0 means "no separate input cap", not a cap of zero.
    return input.model.limit.input
      ? Math.max(0, input.model.limit.input - input.cfg.compaction.reserved)
      : Math.max(0, context - input.cfg.compaction.reserved)
  }

  const percent = input.cfg.compaction?.threshold ?? DEFAULT_COMPACTION_THRESHOLD_PERCENT
  const clamped = Math.min(100, Math.max(1, percent))
  /*
   * A TRUTHY check, not `??`. `limit.input` is 0 for a model that does not publish a separate input cap,
   * and `0 ?? context` is 0 - which made `usable()` return 0, made every session overflow on its first
   * turn, and made a run summarise in a loop until the harness killed it at 30s. The original code used
   * this same truthy form for exactly this reason.
   */
  const budget = input.model.limit.input || context
  /*
   * Still leave room for the reply. A threshold of 100 would mean "compact once the window is full",
   * which is the same failure the reserve was there to avoid, so the output allowance is subtracted
   * either way and the threshold applies to what is left.
   */
  const output = ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax)
  const headroom = Math.max(0, budget - Math.min(COMPACTION_BUFFER, output))
  const windowLimit = Math.floor((headroom * clamped) / 100)
  /*
   * The cheaper of the two limits wins. `reserved` above returns before this on purpose: a caller who set
   * an explicit token budget said that number, and silently tightening it to a price they did not name
   * would be the same overreach the percentage was careful to avoid.
   */
  const ceiling = costCeilingTokens({ cfg: input.cfg, model: input.model, tokens: input.tokens })
  return ceiling === undefined ? windowLimit : Math.min(windowLimit, ceiling)
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  /*
   * Compaction is ON unless it has been turned OFF.
   *
   * This read `auto !== true`, so an absent setting meant no compaction ever - and absent is what every
   * workspace has until someone opens the settings page and toggles it. The desktop app's own settings
   * screen read the same field as `auto !== false` and therefore DISPLAYED it as on, so the two halves
   * disagreed about the default and the visible half was the wrong one. A conversation grew until the
   * gateway refused it for size while the app said it was already handling that.
   *
   * A long conversation is the normal case in a desktop workspace, and summarising one is a better
   * outcome than a request that fails outright. An explicit `false` is still honoured.
   */
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable({ ...input, tokens: count })
}
