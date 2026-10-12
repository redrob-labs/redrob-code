/**
 * Keeps names out of what a reviewer or a chooser sees.
 *
 * Builders are told not to name themselves, and anything that slips through is replaced before a diff
 * or a summary reaches a reviewer or the person picking. It is best effort: style can still give a
 * model away, which is why the product says "names hidden", never "undetectable".
 */

const NAMES = [
  "anthropic",
  "claude",
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "openai",
  "chatgpt",
  "gpt-?\\d[\\w.-]*",
  "codex",
  "gemini",
  "google deepmind",
  "deepmind",
  "qwen\\w*",
  "deepseek",
  "kimi",
  "moonshot",
  "glm-?\\d[\\w.-]*",
  "zhipu",
  "grok",
  "xai",
  "mistral",
  "codestral",
  "devstral",
  "llama",
  "minimax",
]

// The tail takes a model's variant with it (`qwen3-coder`, `claude-opus-5.5`) but not the full stop
// that ends a sentence.
const PATTERN = new RegExp(`\\b(${NAMES.join("|")})(?:[\\w-]|\\.(?=\\w))*`, "gi")

export function redact(text: string, extra: string[] = []) {
  let result = text.replace(PATTERN, "[model]")
  for (const name of extra.filter(Boolean)) {
    result = result.split(name).join("[model]")
  }
  return result
}
