import type { SessionV1 } from "@redrob-code/core/v1/session"

export { parseGitHubRemote } from "@/util/repository"

/**
 * Extracts displayable text from assistant response parts.
 * Returns null for non-text responses (signals summary needed).
 * Throws only for truly empty responses.
 */
export function extractResponseText(parts: SessionV1.Part[]): string | null {
  const textPart = parts.findLast((p) => p.type === "text")
  if (textPart) return textPart.text

  // Non-text parts (tools, reasoning, step-start/step-finish, etc.) - signal summary needed
  if (parts.length > 0) return null

  throw new Error("Failed to parse response: no parts returned")
}

/**
 * Builds a pull request body from the agent's own closing report.
 *
 * `report` is the model's final text turn, ordinarily a written summary of the
 * work. It is not guaranteed to be anything: a turn that ended on a tool call,
 * was cut short, or produced an empty text part leaves it blank, and the trailer
 * alone ("Closes #12") describes nothing. Rather than open a pull request whose
 * entire description is a cross-reference, say plainly that no summary was
 * produced, so a reviewer knows to read the diff instead of trusting a
 * description that is not there.
 *
 * The standalone action carries its own copy of this in `github/index.ts` — it
 * ships as a separate bundle and cannot import this module. Change both.
 */
export function pullRequestBody(report: string, trailer: string): string {
  const summary = report.trim()
  if (summary) return `${summary}\n\n${trailer}`
  return [
    "## Summary",
    "",
    "The agent did not produce a summary for this change. Read the diff and the",
    "commit messages before approving — there is no description to check them against.",
    "",
    trailer,
  ].join("\n")
}

/**
 * Formats a PROMPT_TOO_LARGE error message with details about files in the prompt.
 * Content is base64 encoded, so we calculate original size by multiplying by 0.75.
 */
export function formatPromptTooLargeError(files: { filename: string; content: string }[]): string {
  const fileDetails =
    files.length > 0
      ? `\n\nFiles in prompt:\n${files.map((f) => `  - ${f.filename} (${((f.content.length * 0.75) / 1024).toFixed(0)} KB)`).join("\n")}`
      : ""
  return `PROMPT_TOO_LARGE: The prompt exceeds the model's context limit.${fileDetails}`
}
