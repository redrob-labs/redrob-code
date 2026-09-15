import { EOL } from "os"
import { Schema } from "effect"
import { logo as glyphs } from "./logo"

// Uppercase letterforms, so no row carries an ascender. The blank first row keeps the banner's
// height; opencode used it for the ascender of its lowercase `d`.
const wordmark = [
  `                             `,
  `█▀▀█ █▀▀▀ █▀▀▄ █▀▀█ █▀▀█ █▀▀▄`,
  `█▀▀▄ █▀▀▀ █  █ █▀▀▄ █  █ █▀▀▄`,
  `▀  ▀ ▀▀▀▀ ▀▀▀  ▀  ▀ ▀▀▀▀ ▀▀▀ `,
]

export class CancelledError extends Schema.TaggedErrorClass<CancelledError>()("UICancelledError", {}) {}

/**
 * ANSI SGR, not brand hex, and deliberately so.
 *
 * These style the CLI's own stderr output, which is scrollback the terminal keeps and the user may
 * read in any palette, at any colour depth, over ssh. The bright ANSI slots resolve to whatever the
 * terminal has decided cyan and red are, so the output stays legible on a solarized-light profile,
 * a 16-colour tty and a truecolor emulator alike. Emitting `#2b52ff` here would be a 24-bit escape
 * that a 16-colour terminal drops on the floor and a light profile renders unreadably.
 *
 * The brand's colours reach the terminal through the theme instead, where the renderer knows the
 * terminal's palette and can quantize to it. See `packages/tui/src/theme`.
 */
export const Style = {
  TEXT_HIGHLIGHT: "\x1b[96m",
  TEXT_HIGHLIGHT_BOLD: "\x1b[96m\x1b[1m",
  TEXT_DIM: "\x1b[90m",
  TEXT_DIM_BOLD: "\x1b[90m\x1b[1m",
  TEXT_NORMAL: "\x1b[0m",
  TEXT_NORMAL_BOLD: "\x1b[1m",
  TEXT_WARNING: "\x1b[93m",
  TEXT_WARNING_BOLD: "\x1b[93m\x1b[1m",
  TEXT_DANGER: "\x1b[91m",
  TEXT_DANGER_BOLD: "\x1b[91m\x1b[1m",
  TEXT_SUCCESS: "\x1b[92m",
  TEXT_SUCCESS_BOLD: "\x1b[92m\x1b[1m",
  TEXT_INFO: "\x1b[94m",
  TEXT_INFO_BOLD: "\x1b[94m\x1b[1m",
}

export function println(...message: string[]) {
  print(...message)
  process.stderr.write(EOL)
}

export function print(...message: string[]) {
  blank = false
  process.stderr.write(message.join(" "))
}

let blank = false
export function empty() {
  if (blank) return
  println("" + Style.TEXT_NORMAL)
  blank = true
}

export function logo(pad?: string) {
  if (!process.stdout.isTTY && !process.stderr.isTTY) {
    const result = []
    for (const row of wordmark) {
      if (pad) result.push(pad)
      result.push(row)
      result.push(EOL)
    }
    return result.join("").trimEnd()
  }

  const result: string[] = []
  const reset = "\x1b[0m"
  const left = {
    fg: "\x1b[90m",
    shadow: "\x1b[38;5;235m",
    bg: "\x1b[48;5;235m",
  }
  const right = {
    fg: reset,
    shadow: "\x1b[38;5;238m",
    bg: "\x1b[48;5;238m",
  }
  const gap = " "
  const draw = (line: string, fg: string, shadow: string, bg: string) => {
    const parts: string[] = []
    for (const char of line) {
      if (char === "_") {
        parts.push(bg, " ", reset)
        continue
      }
      if (char === "^") {
        parts.push(fg, bg, "▀", reset)
        continue
      }
      if (char === "~") {
        parts.push(shadow, "▀", reset)
        continue
      }
      if (char === " ") {
        parts.push(" ")
        continue
      }
      parts.push(fg, char, reset)
    }
    return parts.join("")
  }
  glyphs.left.forEach((row, index) => {
    if (pad) result.push(pad)
    result.push(draw(row, left.fg, left.shadow, left.bg))
    result.push(gap)
    const other = glyphs.right[index] ?? ""
    result.push(draw(other, right.fg, right.shadow, right.bg))
    result.push(EOL)
  })
  return result.join("").trimEnd()
}

export async function input(prompt: string): Promise<string> {
  const readline = require("readline")
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

export function error(message: string) {
  if (message.startsWith("Error: ")) {
    message = message.slice("Error: ".length)
  }
  println(Style.TEXT_DANGER_BOLD + "Error: " + Style.TEXT_NORMAL + message)
}

export function markdown(text: string): string {
  return text
}

export * as UI from "./ui"
