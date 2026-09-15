import { DynamicProviderPlugin } from "./provider/dynamic"
import { OpenAICompatiblePlugin } from "./provider/openai-compatible"
import { RedrobPlugin } from "./provider/redrob"
import type { PluginInternal } from "./internal"
import type { Scope } from "effect"

// Only the Redrob console provider (id "redrob", hosted at console.redrob.ai) is user-selectable.
// OpenAICompatiblePlugin and DynamicProviderPlugin are NOT third-party providers; they are AI SDK
// instantiation infrastructure the console provider relies on at runtime: the console serves models
// via "@ai-sdk/openai-compatible" (handled by OpenAICompatiblePlugin) and may reference arbitrary
// aisdk npm packages (resolved by DynamicProviderPlugin). Removing them would leave the console
// provider unable to instantiate its SDK, so they are retained as required infrastructure.
export const ProviderPlugins: PluginInternal.Plugin<PluginInternal.Requirements | Scope.Scope>[] = [
  RedrobPlugin,
  OpenAICompatiblePlugin,
  DynamicProviderPlugin,
]
