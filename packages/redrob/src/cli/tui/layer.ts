import { run as runTui, type TuiInput } from "@redrob-code/tui"
import { Global } from "@redrob-code/core/global"
import { AppNodeBuilder } from "@redrob-code/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
