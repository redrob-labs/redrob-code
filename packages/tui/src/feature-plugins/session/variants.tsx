import type { TuiPlugin, TuiPluginApi } from "@redrob-code/plugin/tui"

import type { BuiltinTuiPlugin } from "../builtins"
import { kvTranslator } from "../../i18n"

const id = "internal:variants"

/**
 * `paraphrase` and `compare`, and the one thing they must both do: say what was used and what it cost.
 *
 * Both go through this server's own `/api/variant/*` routes rather than reaching the console directly, so
 * credential resolution and error mapping live in one place. The routes answer 404 when the Redrob provider
 * is not connected, which is what gates these commands -- a user on a local runtime or another vendor is
 * told the feature is unavailable instead of watching a request fail for reasons that look like their fault.
 *
 * WHY THE COST IS ALWAYS SHOWN. One of these requests makes SEVERAL charges -- one per model. A user who
 * thinks they made one request will be surprised by the bill unless the surprise happens immediately, at the
 * moment they can still decide not to do it again. So every result prints the model that actually answered,
 * per slot, with its own cost and the total.
 */

/** Two is the minimum that makes a comparison, and the console refuses fewer. */
const COMPARE_MINIMUM = 2

export type SlotResult = {
  slot: number
  model: string
  text?: string
  error?: string
  redrob?: {
    routedModel?: string
    upstreamProvider?: string
    latencyMs?: number
    costUsd?: number
  }
}

export type VariantResult = {
  variants: SlotResult[]
  totalCostUsd: number
}

/**
 * What a slot is called when shown to a person.
 *
 * `routedModel` wins over the requested id, because when the request said `auto` the requested id tells the
 * reader nothing they did not already type. Both are shown when they differ, since "I asked for auto and got
 * this" is the interesting fact.
 */
export function describeSlot(slot: SlotResult): string {
  const routed = slot.redrob?.routedModel
  if (routed && routed !== slot.model) return `${slot.model} → ${routed}`
  return routed ?? slot.model
}

/** Dollars at a fixed width, small enough not to round a fraction of a cent to nothing. */
function money(value: number | undefined): string {
  return typeof value === "number" ? `$${value.toFixed(4)}` : "—"
}

/**
 * The cost table.
 *
 * Per slot AND totalled, because the total alone hides that a slot failed for free while another was
 * charged, and the slots alone make a reader do the addition the response already did.
 */
export function costReport(result: VariantResult): string {
  const lines = result.variants.map((slot) => {
    const latency = slot.redrob?.latencyMs
    const timing = typeof latency === "number" ? `${Math.round(latency)}ms` : "—"
    const status = slot.error ? `failed: ${slot.error}` : money(slot.redrob?.costUsd)
    return `  ${describeSlot(slot).padEnd(34)} ${status.padStart(12)}  ${timing.padStart(8)}`
  })
  lines.push(`  ${"total".padEnd(34)} ${money(result.totalCostUsd).padStart(12)}`)
  return lines.join("\n")
}

/** The served slots, in order. A failed slot is not an option a user can pick. */
export function servedSlots(result: VariantResult): SlotResult[] {
  return result.variants.filter((slot) => typeof slot.text === "string" && slot.text.length > 0)
}

/**
 * A one-line preview for the selection list.
 *
 * An answer is usually several lines and the list renders one, so the first non-empty line is shown and the
 * rest is what the user gets when they choose. Truncated rather than wrapped, because a list row that grows
 * pushes the other options off the screen -- which is the opposite of what a chooser needs.
 */
export function previewOf(text: string, width = 72): string {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? ""
  if (firstLine.length <= width) return firstLine
  return `${firstLine.slice(0, width - 1)}…`
}

function activeSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  if (route.name !== "session") return undefined
  const sessionID = route.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

/**
 * The models to fan out to.
 *
 * Taken from what the catalogue says is connected rather than hard-coded, so a deployment that serves
 * different ids does not need this file changed. `auto` is excluded: fanning out to the router twice would
 * be two charges for what may well be the same model, which is the opposite of the point.
 */
function fanOutModels(api: TuiPluginApi, count: number): string[] {
  const redrob = api.state.provider.find((provider) => provider.id === "redrob")
  if (!redrob) return []
  return Object.keys(redrob.models ?? {})
    .filter((model) => model !== "auto")
    .slice(0, count)
}

const tui: TuiPlugin = async (api) => {
  const connected = () => api.state.provider.some((provider) => provider.id === "redrob")

  const requireRedrob = (): boolean => {
    if (connected()) return true
    const t = kvTranslator(api.kv)
    api.ui.toast({
      title: t.t("variants.unavailable.title"),
      message: t.t("variants.unavailable.message"),
      variant: "info",
    })
    return false
  }

  /**
   * Cost first, then the content: the number is the part a user did not ask for and must not miss.
   *
   * A DIALOG rather than a toast, which is where this started. The toast is absolutely positioned at the
   * top-right, capped at sixty columns, and dismisses itself on a timer -- pressing the command for real
   * showed it clipping the cost total and the whole answer, keeping only the first few slot rows. The two
   * things a user most needs were the two it dropped. A dialog is dismissed by the person reading it, so
   * nothing disappears before it has been read.
   */
  const report = (title: string, result: VariantResult, body?: string) => {
    api.ui.dialog.replace(() => (
      <api.ui.DialogAlert
        title={title}
        message={[costReport(result), body ? `\n${body}` : ""].join("")}
        onConfirm={() => api.ui.dialog.clear()}
      />
    ))
  }

  api.keymap.registerLayer({
    commands: [
      {
        name: "variants.paraphrase",
        get title() {
          return kvTranslator(api.kv).t("variants.paraphrase.title")
        },
        category: "Session",
        namespace: "palette",
        run() {
          const t = kvTranslator(api.kv)
          if (!requireRedrob()) return

          api.ui.dialog.replace(() => (
            <api.ui.DialogPrompt
              title={t.t("variants.paraphrase.title")}
              placeholder={t.t("variants.paraphrase.placeholder")}
              onConfirm={(value: string) => {
                const text = value.trim()
                api.ui.dialog.clear()
                if (!text) return

                const models = fanOutModels(api, 3)
                if (models.length === 0) {
                  api.ui.toast({
                    title: t.t("variants.no_models.title"),
                    message: t.t("variants.no_models.message"),
                    variant: "error",
                  })
                  return
                }

                void api.client.v2.variant
                  .paraphrase(
                    {
                      variantParaphraseRequest: {
                        text,
                        models: models.map((model) => ({ model })),
                      },
                    },
                    { throwOnError: true },
                  )
                  .then(({ data: result }) => {
                    const served = servedSlots(result)
                    if (served.length === 0) {
                      /*
                        Every slot failed. The cost report is still shown, because a failed slot can still
                        have been charged and a silent zero would be a claim rather than a fact.
                      */
                      report(t.t("variants.none.title"), result)
                      return
                    }
                    /*
                      Paraphrase returns ONE value to the user: the last served slot, which is the end of the
                      chain the models were asked to refine. The others are not offered as a choice -- that is
                      what `compare` is for -- but every one of them is named in the cost table, so the user
                      can see what the single answer cost to produce.
                    */
                    const chosen = served[served.length - 1]
                    report(t.t("variants.paraphrase.done"), result, chosen.text)
                  })
                  .catch((error: unknown) => {
                    api.ui.toast({
                      title: t.t("variants.failed.title"),
                      message: error instanceof Error ? error.message : String(error),
                      variant: "error",
                    })
                  })
              }}
              onCancel={() => api.ui.dialog.clear()}
            />
          ))
        },
      },
      {
        name: "variants.compare",
        get title() {
          return kvTranslator(api.kv).t("variants.compare.title")
        },
        category: "Session",
        namespace: "palette",
        run() {
          const t = kvTranslator(api.kv)
          if (!requireRedrob()) return

          const sessionID = activeSessionID(api)
          if (!sessionID) {
            api.ui.toast({
              title: t.t("variants.needs_session.title"),
              message: t.t("variants.needs_session.message"),
              variant: "error",
            })
            return
          }

          api.ui.dialog.replace(() => (
            <api.ui.DialogPrompt
              title={t.t("variants.compare.title")}
              placeholder={t.t("variants.compare.placeholder")}
              onConfirm={(value: string) => {
                const question = value.trim()
                api.ui.dialog.clear()
                if (!question) return

                const models = fanOutModels(api, COMPARE_MINIMUM)
                if (models.length < COMPARE_MINIMUM) {
                  api.ui.toast({
                    title: t.t("variants.no_models.title"),
                    message: t.t("variants.no_models.message"),
                    variant: "error",
                  })
                  return
                }

                void api.client.v2.variant
                  .compare(
                    {
                      variantCompareRequest: {
                        messages: [{ role: "user", content: question }],
                        models: models.map((model) => ({ model })),
                      },
                    },
                    { throwOnError: true },
                  )
                  .then(({ data: result }) => {
                    const served = servedSlots(result)
                    if (served.length === 0) {
                      report(t.t("variants.none.title"), result)
                      return
                    }

                    /*
                      Cost BEFORE the choice, and the choice only once the cost has been acknowledged.
                      These are two dialogs on one stack, so opening the chooser directly would replace the
                      cost dialog the instant it appeared -- which is the same disappearing-evidence problem
                      the toast had. Confirming the cost is what opens the chooser.
                    */
                    api.ui.dialog.replace(() => (
                      <api.ui.DialogAlert
                        title={t.t("variants.compare.done")}
                        message={costReport(result)}
                        onConfirm={() => {
                          /*
                            Deferred by a tick on purpose. `DialogAlert` calls this and then clears the
                            dialog stack itself, so a chooser pushed synchronously here is opened and then
                            immediately wiped by that clear -- which is what happened the first time this
                            was driven by hand: the cost dialog closed and nothing replaced it. Queuing the
                            push means it lands after the clear rather than before it.
                          */
                          setTimeout(() => {
                            api.ui.dialog.replace(() => (
                              <api.ui.DialogSelect<number>
                                title={t.t("variants.compare.choose")}
                                options={served.map((slot, index) => ({
                                  title: `${describeSlot(slot)} · ${money(slot.redrob?.costUsd)}`,
                                  value: index,
                                  description: previewOf(slot.text ?? ""),
                                }))}
                                onSelect={(option) => {
                                  api.ui.dialog.clear()
                                  const chosen = served[option.value]
                                  if (!chosen?.text) return
                                  void api.client.v2.session
                                    .prompt(
                                      {
                                        sessionID,
                                        prompt: {
                                          text: [
                                            question,
                                            "",
                                            `(answered by ${describeSlot(chosen)})`,
                                            "",
                                            chosen.text,
                                          ].join("\n"),
                                        },
                                      },
                                      { throwOnError: true },
                                    )
                                    /*
                                      Reported rather than swallowed. Without this the first hand-run looked
                                      like the pick had simply done nothing: the dialog closed, the answer
                                      never arrived, and the reason was discarded with the rejected promise.
                                      A user who has just been charged for several models must be told when
                                      the thing they paid for failed to land.
                                    */
                                    .catch((error: unknown) => {
                                      api.ui.toast({
                                        title: t.t("variants.insert_failed.title"),
                                        message: error instanceof Error ? error.message : String(error),
                                        variant: "error",
                                      })
                                    })
                                }}
                              />
                            ))
                          }, 0)
                        }}
                      />
                    ))
                  })
                  .catch((error: unknown) => {
                    api.ui.toast({
                      title: t.t("variants.failed.title"),
                      message: error instanceof Error ? error.message : String(error),
                      variant: "error",
                    })
                  })
              }}
              onCancel={() => api.ui.dialog.clear()}
            />
          ))
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("variants.palette", [
      "variants.paraphrase",
      "variants.compare",
    ]),
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
