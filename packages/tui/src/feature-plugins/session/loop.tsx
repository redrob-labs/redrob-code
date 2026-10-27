import type { TuiPlugin, TuiPluginApi } from "@redrob-code/plugin/tui"
import type { Routine } from "@redrob-labs/sdk/v2"

import type { BuiltinTuiPlugin } from "../builtins"
import { kvTranslator } from "../../i18n"

const id = "internal:loop"

/**
 * Autopilot in the terminal: a thin screen over the server's routine engine.
 *
 * The goal, the ledger of rejected approaches, the prompt and the judging of each reply all live on
 * the server (packages/redrob/src/routine), so the same autopilot can be started from a phone, the
 * web or desktop, and it keeps going when this terminal closes. This file only starts, resumes and
 * stops routines and says what happened to them.
 */

/** The session the user is looking at, read from the route. */
function activeSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  if (route.name !== "session") return undefined
  const sessionID = route.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

const isActive = (routine: Routine) => routine.status === "running" || routine.status === "paused"

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function sessionRoutines(api: TuiPluginApi, sessionID: string): Promise<Routine[]> {
  const result = await api.client.routine.list({ sessionID }, { throwOnError: true })
  return result.data ?? []
}

const tui: TuiPlugin = async (api) => {
  /*
    Tell the user when a routine ends, whoever ended it: the engine, a phone, the agent's own tool.
    Only transitions out of `running` are worth a toast; progress is visible in the transcript.
  */
  api.event.on("routine.updated", (event) => {
    const info = event.properties.info
    if (info.status === "running") return
    const t = kvTranslator(api.kv)
    const message =
      info.status === "done"
        ? t.t("loop.stopped.done")
        : info.status === "blocked"
          ? [t.t("loop.stopped.blocked"), info.reason].filter(Boolean).join("\n")
          : info.status === "paused"
            ? [t.t("loop.stopped.paused"), info.reason].filter(Boolean).join("\n")
            : (info.reason ?? t.t("loop.stopped.user"))
    api.ui.toast({
      title: t.t("loop.stopped.title"),
      message,
      variant: info.status === "stopped" && info.reason && info.reason !== "Stopped by the user." ? "error" : "info",
    })
  })

  const fail = (error: unknown) =>
    api.ui.toast({
      title: kvTranslator(api.kv).t("loop.failed.title"),
      message: errorMessage(error),
      variant: "error",
    })

  api.keymap.registerLayer({
    commands: [
      {
        name: "loop.start",
        get title() {
          return kvTranslator(api.kv).t("loop.start.title")
        },
        category: "Session",
        namespace: "palette",
        async run() {
          const t = kvTranslator(api.kv)
          const sessionID = activeSessionID(api)
          if (!sessionID) {
            api.ui.toast({
              title: t.t("loop.needs_session.title"),
              message: t.t("loop.needs_session.message"),
              variant: "error",
            })
            return
          }

          const existing = await sessionRoutines(api, sessionID).catch((error) => {
            fail(error)
            return undefined
          })
          if (!existing) return

          /* Newest last; an autopilot that stopped on a block keeps its dead ends for a resume. */
          const autopilot = existing.filter((item) => item.trigger.type === "after_turn").at(-1)
          if (autopilot?.status === "running") {
            api.ui.toast({
              title: t.t("loop.already.title"),
              message: t.t("loop.status", { cycle: String(autopilot.cycles), max: String(autopilot.maxCycles) }),
              variant: "info",
            })
            return
          }
          const resumable = autopilot && (autopilot.status === "paused" || autopilot.status === "blocked")

          api.ui.dialog.replace(() => (
            <api.ui.DialogPrompt
              title={t.t("loop.start.title")}
              value={resumable ? autopilot.goal : undefined}
              placeholder={t.t("loop.start.placeholder")}
              onConfirm={(value: string) => {
                const goal = value.trim()
                api.ui.dialog.clear()
                if (!goal) return
                void (async () => {
                  /*
                    The same goal resumes, keeping the approaches already ruled out. A different goal
                    starts fresh: old dead ends were dead ends for a different question.
                  */
                  if (resumable && autopilot.goal === goal) {
                    await api.client.routine.resume({ routineID: autopilot.id }, { throwOnError: true })
                    api.ui.toast({ title: t.t("loop.resumed.title"), message: goal, variant: "info" })
                    return
                  }
                  if (autopilot && isActive(autopilot)) {
                    await api.client.routine.stop({ routineID: autopilot.id }, { throwOnError: true })
                  }
                  await api.client.routine.create(
                    { routineCreateInput: { sessionID, goal, trigger: { type: "after_turn" } } },
                    { throwOnError: true },
                  )
                  api.ui.toast({ title: t.t("loop.started.title"), message: goal, variant: "info" })
                })().catch(fail)
              }}
              onCancel={() => api.ui.dialog.clear()}
            />
          ))
        },
      },
      {
        name: "loop.stop",
        get title() {
          return kvTranslator(api.kv).t("loop.stop.title")
        },
        category: "Session",
        namespace: "palette",
        async run() {
          const t = kvTranslator(api.kv)
          const sessionID = activeSessionID(api)
          if (!sessionID) return
          try {
            /* One stop for every routine of this session, whatever wakes it. */
            const active = (await sessionRoutines(api, sessionID)).filter(isActive)
            if (active.length === 0) {
              api.ui.toast({ title: t.t("loop.none.title"), message: t.t("loop.none.message"), variant: "info" })
              return
            }
            for (const routine of active) {
              await api.client.routine.stop({ routineID: routine.id }, { throwOnError: true })
            }
          } catch (error) {
            fail(error)
          }
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("loop.palette", ["loop.start", "loop.stop"]),
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
