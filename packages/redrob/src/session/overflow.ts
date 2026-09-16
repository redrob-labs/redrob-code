import type { Config } from "@/config/config"
import { ConfigV1 } from "@redrob-code/core/v1/config/config"
import { SessionV1 } from "@redrob-code/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
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
