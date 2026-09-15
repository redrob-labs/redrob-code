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
// A function rather than an array, because this module sits in an import cycle:
// provider.ts -> provider/openai-compatible.ts -> plugin/internal.ts -> provider.ts.
// As a module-level array the references were read while the cycle was still resolving, so
// whichever module happened to be entered first decided whether they were initialized yet.
// Importing this file directly threw `Cannot access 'OpenAICompatiblePlugin' before
// initialization`; importing it after something else had already pulled the plugins in
// worked. The suite passed only because a file earlier in the serial run warmed the order,
// and running that one test on its own failed -- in serial as well as in parallel.
//
// Building the list on call defers every reference past module evaluation, which is what
// makes the order irrelevant. Its only consumer reads it inside an Effect generator body,
// so nothing has to change about when it is available.
export const ProviderPlugins = (): PluginInternal.Plugin<PluginInternal.Requirements | Scope.Scope>[] => [
  RedrobPlugin,
  OpenAICompatiblePlugin,
  DynamicProviderPlugin,
]
