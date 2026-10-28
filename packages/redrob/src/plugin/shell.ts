import type { PluginInput } from "@redrob-code/plugin"
import { Shell } from "@redrob-code/core/shell"
import { Process } from "@/util/process"

type PluginShell = PluginInput["$"]
type ShellPromise = ReturnType<PluginShell>
type ShellOutput = Awaited<ShellPromise>
type Expression = Parameters<PluginShell>[1]

/**
 * The `$` handed to plugins.
 *
 * On Windows `Bun.$` opens a console window for every command it runs, which flashes on top of the
 * desktop app each time a plugin checks git or runs a tool. There the plugins get this shell instead:
 * the same tagged-template API (`await $\`cmd\``, `.text()`, `.json()`, `.lines()`, `.quiet()`,
 * `.nothrow()`, `.throws()`, `.cwd()`, `.env()`, `$.escape()`, `$.cwd()`, `$.env()`, `$.nothrow()`),
 * run through the shared spawn helper with `windowsHide`. The command runs in Git Bash when Git for
 * Windows is installed (the closest to Bun's bash-like syntax), otherwise in cmd.exe. Interpolated values
 * are quoted for that shell. Output is buffered, never echoed, and `.stdin` is not available.
 *
 * Everywhere else plugins keep `Bun.$` itself.
 */
export function pluginShell(): PluginShell | undefined {
  if (process.platform === "win32") return make({ throws: true })
  return typeof Bun === "undefined" ? undefined : (Bun.$ as unknown as PluginShell)
}

type Defaults = {
  cwd?: string
  env?: Record<string, string | undefined>
  throws: boolean
}

type Target = { file: string; posix: boolean }

let target: Target | undefined
function shellTarget(): Target {
  if (target) return target
  const bash = Shell.gitbash()
  target = bash ? { file: bash, posix: true } : { file: process.env.ComSpec || "cmd.exe", posix: false }
  return target
}

function quote(value: string): string {
  if (value !== "" && /^[\w@%+=:,./\\-]+$/.test(value)) return value
  if (shellTarget().posix) return `'${value.replace(/'/g, `'\\''`)}'`
  return `"${value.replace(/"/g, '""')}"`
}

function render(strings: TemplateStringsArray, expressions: Expression[]): string {
  let out = strings[0] ?? ""
  for (let i = 0; i < expressions.length; i++) {
    out += expression(expressions[i]) + (strings[i + 1] ?? "")
  }
  return out
}

function expression(value: unknown): string {
  if (Array.isArray(value)) return value.map(expression).join(" ")
  if (typeof value === "object" && value !== null && "raw" in value && typeof value.raw === "string") return value.raw
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) {
    throw new Error("The plugin shell on Windows does not take a stream as input")
  }
  return quote(String(value))
}

function make(defaults: Defaults): PluginShell {
  const shell = ((strings: TemplateStringsArray, ...expressions: Expression[]) =>
    command(render(strings, expressions), defaults)) as PluginShell
  shell.braces = (pattern: string) => {
    if (typeof Bun !== "undefined") return Bun.$.braces(pattern)
    return [pattern]
  }
  shell.escape = quote
  shell.env = (env?: Record<string, string | undefined>) => make({ ...defaults, env })
  shell.cwd = (cwd?: string) => make({ ...defaults, cwd })
  shell.nothrow = () => make({ ...defaults, throws: false })
  shell.throws = (throws: boolean) => make({ ...defaults, throws })
  return shell
}

function command(text: string, defaults: Defaults): ShellPromise {
  const state = { ...defaults }
  let started: Promise<ShellOutput> | undefined
  const start = () => (started ??= execute(text, state))
  const self = {
    get stdin(): WritableStream {
      throw new Error("The plugin shell on Windows has no stdin")
    },
    cwd(cwd: string) {
      state.cwd = cwd
      return self
    },
    env(env: Record<string, string> | undefined) {
      state.env = env
      return self
    },
    quiet() {
      return self
    },
    nothrow() {
      state.throws = false
      return self
    },
    throws(throws: boolean) {
      state.throws = throws
      return self
    },
    async *lines() {
      const output = await start()
      for (const line of output.text().split(/\r?\n/)) {
        if (line) yield line
      }
    },
    text(encoding?: BufferEncoding) {
      return start().then((output) => output.text(encoding))
    },
    json() {
      return start().then((output) => output.json())
    },
    arrayBuffer() {
      return start().then((output) => output.arrayBuffer())
    },
    blob() {
      return start().then((output) => output.blob())
    },
    then<A = ShellOutput, B = never>(
      onfulfilled?: ((value: ShellOutput) => A | PromiseLike<A>) | null,
      onrejected?: ((reason: any) => B | PromiseLike<B>) | null,
    ) {
      return start().then(onfulfilled, onrejected)
    },
    catch<B = never>(onrejected?: ((reason: any) => B | PromiseLike<B>) | null) {
      return start().catch(onrejected)
    },
    finally(onfinally?: (() => void) | null) {
      return start().finally(onfinally)
    },
    [Symbol.toStringTag]: "ShellPromise",
  }
  // Bun.$ runs a command even when nobody awaits it; modifiers chained in the same tick still apply.
  queueMicrotask(() => void start().catch(() => undefined))
  return self as unknown as ShellPromise
}

async function execute(text: string, state: Defaults): Promise<ShellOutput> {
  const shell = shellTarget()
  const env = state.env
    ? Object.fromEntries(Object.entries(state.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    : undefined
  const result = shell.posix
    ? await Process.run([shell.file, "-c", text], { cwd: state.cwd, env, nothrow: true })
    : await Process.run([text], { cwd: state.cwd, env, shell: true, nothrow: true })
  const output = toOutput(result)
  if (result.code !== 0 && state.throws) {
    const error = new Error(
      `Failed with exit code ${result.code}${result.stderr.length ? `\n${result.stderr.toString().trim()}` : ""}`,
    )
    error.name = "ShellError"
    throw Object.assign(error, output)
  }
  return output
}

function toOutput(result: Process.Result): ShellOutput {
  const stdout = result.stdout
  return {
    stdout,
    stderr: result.stderr,
    exitCode: result.code,
    text: (encoding?: BufferEncoding) => stdout.toString(encoding),
    json: () => JSON.parse(stdout.toString()),
    arrayBuffer: () => stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength) as ArrayBuffer,
    bytes: () => new Uint8Array(stdout),
    blob: () => new Blob([new Uint8Array(stdout)]),
  }
}
