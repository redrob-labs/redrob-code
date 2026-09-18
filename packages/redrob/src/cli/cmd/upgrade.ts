import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { InstallationVersion } from "@redrob-code/core/installation/version"

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: "upgrade redrob to the latest or a specific version",
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", {
        describe: "version to upgrade to, for ex '0.1.48' or 'v0.1.48'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        choices: ["curl"],
      })
  },
  handler: async (args: { target?: string; method?: string }) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")
    const detectedMethod = await Installation.method()
    const method = (args.method as Installation.Method) ?? detectedMethod
    if (method === "unknown") {
      // Not "managed by a package manager": there are no package-manager channels, so the only
      // thing this can mean is a binary install.sh did not place. Saying otherwise sends the
      // reader off to run `brew upgrade` against a formula that does not exist.
      prompts.log.error(
        `redrob at ${process.execPath} was not installed by install.sh, so upgrading in place would write into whatever directory it is sitting in.`,
      )
      prompts.log.info(
        "install.sh installs into $HOME/.redrob/bin. A build from source or a copy moved elsewhere is upgraded by reinstalling.",
      )
      const install = await prompts.select({
        message: "Install anyways?",
        options: [
          { label: "Yes", value: true },
          { label: "No", value: false },
        ],
        initialValue: false,
      })
      if (!install) {
        prompts.outro("Done")
        return
      }
    }
    prompts.log.info("Using method: " + method)
    // A version that cannot be read is a normal state, not a stack trace: the release marker only
    // exists from the first release that publishes it, and the network can be down.
    const target = args.target ? args.target.replace(/^v/, "") : await Installation.latest().catch(() => undefined)
    if (!target) {
      prompts.log.error("Could not work out the latest published version. Name one, for ex 'redrob upgrade 0.1.48'")
      prompts.outro("Done")
      return
    }

    if (InstallationVersion === target) {
      prompts.log.warn(`redrob upgrade skipped: ${target} is already installed`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`From ${InstallationVersion} → ${target}`)
    const spinner = prompts.spinner()
    spinner.start("Upgrading...")
    const err = await Installation.upgrade(method, target).catch((err) => err)
    if (err) {
      spinner.stop("Upgrade failed", 1)
      if (err instanceof Installation.UpgradeFailedError) {
        prompts.log.error(err.stderr)
      } else if (err instanceof Error) prompts.log.error(err.message)
      prompts.outro("Done")
      return
    }
    spinner.stop("Upgrade complete")
    prompts.outro("Done")
  },
}
