import path from "path"
import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { ShareNext } from "@/share/share-next"
import { UI } from "../ui"

/** Redrob Chat refuses bodies over 2 MB; checked here so the user gets a clear message, not a 413. */
const MAX_BYTES = 2 * 1024 * 1024

function format(file: string): { format: ShareNext.ArtifactInput["format"]; language?: string } {
  const ext = path.extname(file).slice(1).toLowerCase()
  if (ext === "md" || ext === "markdown" || ext === "mdx") return { format: "markdown" }
  if (ext === "html" || ext === "htm") return { format: "html" }
  if (ext === "json") return { format: "json" }
  return { format: "code", language: ext || undefined }
}

/** `--lines 10-40` (1-based, inclusive) or `--lines 12` for one line. */
function slice(text: string, lines?: string) {
  if (!lines) return text
  const match = lines.match(/^(\d+)(?:-(\d+))?$/)
  if (!match) return undefined
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : start
  if (start < 1 || end < start) return undefined
  return text.split("\n").slice(start - 1, end).join("\n")
}

export const ShareCommand = effectCmd({
  command: "share <file>",
  describe: "share a file or snippet to Redrob Chat",
  builder: (yargs) =>
    yargs
      .positional("file", {
        describe: "file to share",
        type: "string",
        demandOption: true,
      })
      .option("lines", {
        describe: "only share these lines, e.g. 10-40",
        type: "string",
      })
      .option("title", {
        describe: "title shown on the share page",
        type: "string",
      }),
  handler: Effect.fn("Cli.share")(function* (args) {
    const file = path.resolve(args.file)
    const text = yield* Effect.tryPromise(() => Bun.file(file).text()).pipe(
      Effect.catch(() => fail(`Cannot read ${args.file}`)),
    )
    const body = slice(text, args.lines)
    if (body === undefined) return yield* fail(`Invalid --lines value: ${args.lines}`)
    if (Buffer.byteLength(body, "utf8") > MAX_BYTES) return yield* fail("File is larger than 2 MB")

    const name = path.basename(file)
    const title = args.title ?? (args.lines ? `${name}:${args.lines}` : name)
    const result = yield* ShareNext.Service.use((svc) => svc.artifact({ title, body, ...format(file) })).pipe(
      Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))),
    )
    UI.println(UI.Style.TEXT_INFO_BOLD + "~  " + result.url + UI.Style.TEXT_NORMAL)
  }),
})
