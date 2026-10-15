import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { AppProcess } from "@redrob-code/core/process"
import { LocalGpuProbe } from "@redrob-code/core/config/plugin/local-gpu-probe"
import { LocalModelFit } from "@redrob-code/core/config/plugin/local-model-fit"
import { LocalModelPull } from "@redrob-code/core/config/plugin/local-model-pull"
import { isLocalEndpoint } from "@redrob-code/core/config/plugin/local-provider"
import { Config } from "@/config/config"
import { effectCmd } from "../effect-cmd"
import { UI } from "../ui"

/**
 * PA-8's surface: what this machine can run, and what it cannot, with the numbers.
 *
 * The judgement and the probes are libraries with their own tests; this is the one place a
 * person can see them. Without it the fit check is code nobody reaches -- the failure this
 * queue has now found three times (an arming matcher with no caller, a model preference read
 * and discarded, builtin skills registered into a list with no consumer).
 *
 * A COMMAND rather than a settings page, because the engine has no settings UI of its own and
 * the browser's would mean a mojom round trip for a read that is already local. The browser
 * can call this later; the numbers are the part that had nowhere to appear.
 *
 * TOP-LEVEL rather than `models local`, deliberately. `models` takes a POSITIONAL provider
 * filter (`models anthropic`), so adding a subcommand under it makes `models local` ambiguous
 * -- yargs cannot tell the subcommand from a provider that happens to be called `local`.
 *
 * NO CLOUD FALLBACK is offered or hinted at anywhere here. A user asking what their own
 * machine can run is not asking to be sold a hosted model.
 */

const GiB = 1024 ** 3
const gib = (bytes: number): string => `${(bytes / GiB).toFixed(1)} GiB`

export const ModelsLocalCommand = effectCmd({
  command: "models-local",
  describe: "what this machine can run, and what it cannot",
  builder: (yargs) => yargs,
  handler: Effect.fn("Cli.models.local")(
    function* (_args) {
      /*
       * A failed GPU probe reports NOT MEASURED, never "no GPU".
       *
       * The probe shells out, and on a machine with no discrete card the tool simply does
       * not exist -- the normal state of the world, not a condition to report. The memory
       * judgement, which is the part that actually decides whether a model runs, does not
       * depend on it.
       */
      const gpu = yield* LocalGpuProbe.probe(process.platform).pipe(
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
      const hardware = LocalModelFit.measure(gpu)

    UI.println(UI.Style.TEXT_NORMAL_BOLD + "This machine" + UI.Style.TEXT_NORMAL)
    UI.println(`  platform  ${hardware.platform} ${hardware.arch}`)
    UI.println(`  cores     ${hardware.cores}`)
    UI.println(`  memory    ${gib(hardware.availableBytes)} free of ${gib(hardware.totalBytes)}`)
    // "not measured", never "none". A machine with a card we could not see must not be told
    // it has no card -- that is a false statement about the user's own computer.
    UI.println(
      `  gpu       ${
        gpu === undefined
          ? "not measured on this platform"
          : gpu.vramBytes === undefined
            ? gpu.name
            : `${gpu.name}, ${gib(gpu.vramBytes)}`
      }`,
    )
    UI.println("")

    // Only endpoints the local rule already allows. Re-checked here rather than trusted,
    // the same way the model listing re-checks it: this command would otherwise be a way to
    // make the CLI call an arbitrary host by editing a config file.
    const config = yield* (yield* Config.Service).get()
    const endpoints = Object.values(config.provider ?? {})
      .map((provider) => (provider as { options?: { baseURL?: string } }).options?.baseURL)
      .filter((url): url is string => typeof url === "string" && isLocalEndpoint(url))

    if (endpoints.length === 0) {
      UI.println(UI.Style.TEXT_DIM + "No local model runtime is configured." + UI.Style.TEXT_NORMAL)
      // Said plainly, because "no models" and "nowhere to look for models" are different
      // facts and a user who sees the first will go looking for a model they already have.
      UI.println(
        UI.Style.TEXT_DIM +
          "Point a provider at one on this machine to see what it is serving." +
          UI.Style.TEXT_NORMAL,
      )
      return
    }

    let sawRuntime = false
    for (const endpoint of endpoints) {
      const { reachable, models } = yield* LocalModelPull.installed(endpoint)
      if (!reachable) {
        // Not an error. A runtime that is not running is the normal state of a laptop, and
        // the honest line says which endpoint did not answer rather than implying the
        // machine cannot run anything.
        UI.println(`${endpoint}  ${UI.Style.TEXT_DIM}not answering${UI.Style.TEXT_NORMAL}`)
        continue
      }
      sawRuntime = true
      UI.println(UI.Style.TEXT_NORMAL_BOLD + endpoint + UI.Style.TEXT_NORMAL)
      if (models.length === 0) {
        UI.println(`  ${UI.Style.TEXT_DIM}answering, with nothing installed${UI.Style.TEXT_NORMAL}`)
        continue
      }
      for (const model of models) {
        const verdict = LocalModelFit.fit({ modelBytes: model.size, hardware })
        if (verdict.kind === "fits") {
          UI.println(`  ${model.name}  ${gib(model.size)}  runs here`)
          continue
        }
        // The refusal carries its own numbers, so the line is the library's sentence rather
        // than a re-worded summary that could disagree with it.
        UI.println(`  ${model.name}  ${gib(model.size)}  ${UI.Style.TEXT_DIM}${verdict.reason}${UI.Style.TEXT_NORMAL}`)
      }
    }

    if (!sawRuntime) {
      UI.println("")
      UI.println(
        UI.Style.TEXT_DIM +
          "Every configured local endpoint is down, so nothing could be listed." +
          UI.Style.TEXT_NORMAL,
      )
    }
  }, (effect) =>
    // Both provided here rather than added to the CLI runtime: this is the only command that
    // speaks HTTP to a local runtime or shells out for a GPU, and widening the shared runtime
    // for one command would hand both to every other command that has no use for them.
    Effect.provide(effect, Layer.mergeAll(FetchHttpClient.layer, LayerNode.compile(AppProcess.node))),
  ),
})
