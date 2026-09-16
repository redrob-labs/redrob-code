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

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  /*
   * An explicit `reserved` still wins, because it is the older and more specific knob: a caller who set
   * a token budget meant that number and not a percentage of a window they may not know.
   */
  if (input.cfg.compaction?.reserved !== undefined) {
    return input.model.limit.input
      ? Math.max(0, input.model.limit.input - input.cfg.compaction.reserved)
      : Math.max(0, context - input.cfg.compaction.reserved)
  }

  const percent = input.cfg.compaction?.threshold ?? DEFAULT_COMPACTION_THRESHOLD_PERCENT
  const clamped = Math.min(100, Math.max(1, percent))
  const budget = input.model.limit.input ?? context
  /*
   * Still leave room for the reply. A threshold of 100 would mean "compact once the window is full",
   * which is the same failure the reserve was there to avoid, so the output allowance is subtracted
   * either way and the threshold applies to what is left.
   */
  const output = ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax)
  const headroom = Math.max(0, budget - Math.min(COMPACTION_BUFFER, output))
  return Math.floor((headroom * clamped) / 100)
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
  return count >= usable(input)
}
