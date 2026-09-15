import { Schema } from "effect"
import { NamedError } from "@redrob-code/core/util/error"
import { Process } from "@/util/process"
import { IdeEvent } from "@redrob-code/schema/ide-event"

const SUPPORTED_IDES = [
  { name: "Windsurf" as const, cmd: "windsurf" },
  { name: "Visual Studio Code - Insiders" as const, cmd: "code-insiders" },
  { name: "Visual Studio Code" as const, cmd: "code" },
  { name: "Cursor" as const, cmd: "cursor" },
  { name: "VSCodium" as const, cmd: "codium" },
]

export const Event = IdeEvent

export const AlreadyInstalledError = NamedError.create("AlreadyInstalledError", {})

export const InstallFailedError = NamedError.create("InstallFailedError", {
  stderr: Schema.String,
})

export function ide() {
  if (process.env["TERM_PROGRAM"] === "vscode") {
    const v = process.env["GIT_ASKPASS"]
    for (const ide of SUPPORTED_IDES) {
      if (v?.includes(ide.name)) return ide.name
    }
  }
  return "unknown"
}

export function alreadyInstalled() {
  return process.env["REDROB_CALLER"] === "vscode" || process.env["REDROB_CALLER"] === "vscode-insiders"
}

export async function install(ide: (typeof SUPPORTED_IDES)[number]["name"]) {
  const cmd = SUPPORTED_IDES.find((i) => i.name === ide)?.cmd
  if (!cmd) throw new Error(`Unknown IDE: ${ide}`)

  // Must match sdks/vscode/package.json's "publisher"."name". The rebrand renamed the
  // extension but not the publisher, leaving `sst-dev.redrob` -- an id that resolves to
  // nothing: upstream publishes `sst-dev.opencode` and ours is published by
  // `redrob-labs`. The install silently found no extension either way.
  const p = await Process.run([cmd, "--install-extension", "redrob-labs.redrob-code"], {
    nothrow: true,
  })
  const stdout = p.stdout.toString()
  const stderr = p.stderr.toString()

  if (p.code !== 0) {
    throw new InstallFailedError({ stderr })
  }
  if (stdout.includes("already installed")) {
    throw new AlreadyInstalledError({})
  }
}

export * as Ide from "."
