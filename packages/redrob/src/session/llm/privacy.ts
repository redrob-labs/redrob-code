import type {
  LanguageModelV3Middleware,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolResultOutput,
} from "@ai-sdk/provider"
import { Mask } from "@redrob-code/core/privacy/mask"
import type { ModelMessage } from "ai"

/**
 * PII masking for the v1 session path (desktop chat turns), the same switch and masker the v2
 * runner uses. The AI SDK runs tools inside `streamText`, before any event reaches the processor,
 * so masking sits at the model boundary: `transformParams` masks the prompt the provider sees, and
 * `wrapStream` puts real values back into text, reasoning and tool-call input, so tools run on the
 * real thing and the person reads the real thing.
 */

/** One vault per session for the life of the process, so a value keeps its placeholder across turns. */
export class Vaults {
  private readonly vaults = new Map<string, Mask.Vault>()

  /** The vault for this turn, or nothing when masking is off. */
  forTurn(settings: Mask.Settings, sessionID: string): Mask.Vault | undefined {
    if (settings.mode === "off") return undefined
    const vault = this.vaults.get(sessionID) ?? new Mask.Vault()
    this.vaults.set(sessionID, vault)
    return vault
  }
}

const maskOutput = (vault: Mask.Vault, output: LanguageModelV3ToolResultOutput): LanguageModelV3ToolResultOutput => {
  switch (output.type) {
    case "text":
    case "error-text":
      return { ...output, value: vault.maskText(output.value) }
    case "json":
    case "error-json":
      return { ...output, value: vault.maskDeep(output.value) }
    case "execution-denied":
      return output.reason === undefined ? output : { ...output, reason: vault.maskText(output.reason) }
    case "content":
      return {
        ...output,
        value: output.value.map((item) => (item.type === "text" ? { ...item, text: vault.maskText(item.text) } : item)),
      }
  }
  return output
}

/** The prompt as the provider will see it: system, user, assistant and tool text all masked. */
export const maskPrompt = (vault: Mask.Vault, prompt: LanguageModelV3Prompt): LanguageModelV3Prompt =>
  prompt.map((message) => {
    switch (message.role) {
      case "system":
        return { ...message, content: vault.maskText(message.content) }
      case "user":
        return {
          ...message,
          content: message.content.map((part) => (part.type === "text" ? { ...part, text: vault.maskText(part.text) } : part)),
        }
      case "assistant":
        return {
          ...message,
          content: message.content.map((part) => {
            if (part.type === "text" || part.type === "reasoning") return { ...part, text: vault.maskText(part.text) }
            if (part.type === "tool-call") return { ...part, input: vault.maskDeep(part.input) }
            if (part.type === "tool-result") return { ...part, output: maskOutput(vault, part.output) }
            return part
          }),
        }
      case "tool":
        return {
          ...message,
          content: message.content.map((part) =>
            part.type === "tool-result" ? { ...part, output: maskOutput(vault, part.output) } : part,
          ),
        }
    }
    return message
  }) as LanguageModelV3Prompt

/** The texts a model-tier detector should read: what the person and the tools wrote, never the system prompt. */
export const readableTexts = (messages: readonly ModelMessage[]): string[] =>
  messages.flatMap((message) => {
    if (message.role === "system") return []
    if (typeof message.content === "string") return [message.content]
    return message.content.flatMap((part): string[] => {
      if (part.type === "text") return [part.text]
      if (part.type === "tool-result") {
        const output = part.output
        if (output.type === "text" || output.type === "error-text") return [output.value]
        if (output.type === "json" || output.type === "error-json") return [JSON.stringify(output.value)]
        if (output.type === "content")
          return output.value.flatMap((item) => (item.type === "text" ? [item.text] : []))
      }
      return []
    })
  })

/** Tool-call input arrives as a JSON string; unmask the values inside it, not the raw text, so quoting stays valid. */
const unmaskInput = (vault: Mask.Vault, input: string) => {
  try {
    return JSON.stringify(vault.unmaskDeep(JSON.parse(input)))
  } catch {
    return vault.unmask(input)
  }
}

/** Put real values back into the provider stream. Deltas go through a per-block unmasker; a placeholder split across chunks is held back. */
export const unmaskStream = (vault: Mask.Vault) => {
  const blocks = new Map<string, ReturnType<Mask.Vault["unmasker"]>>()
  const block = (key: string) => {
    const found = blocks.get(key) ?? vault.unmasker()
    blocks.set(key, found)
    return found
  }
  const rest = (key: string) => {
    const text = blocks.get(key)?.flush() ?? ""
    blocks.delete(key)
    return text ? vault.unmask(text) : ""
  }
  return new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
    transform(part, controller) {
      switch (part.type) {
        case "text-delta":
          controller.enqueue({ ...part, delta: block(`text:${part.id}`).push(part.delta) })
          return
        case "reasoning-delta":
          controller.enqueue({ ...part, delta: block(`reasoning:${part.id}`).push(part.delta) })
          return
        case "tool-input-delta":
          controller.enqueue({ ...part, delta: block(`tool:${part.id}`).push(part.delta) })
          return
        case "text-end": {
          const text = rest(`text:${part.id}`)
          if (text) controller.enqueue({ type: "text-delta", id: part.id, delta: text })
          controller.enqueue(part)
          return
        }
        case "reasoning-end": {
          const text = rest(`reasoning:${part.id}`)
          if (text) controller.enqueue({ type: "reasoning-delta", id: part.id, delta: text })
          controller.enqueue(part)
          return
        }
        case "tool-input-end": {
          const text = rest(`tool:${part.id}`)
          if (text) controller.enqueue({ type: "tool-input-delta", id: part.id, delta: text })
          controller.enqueue(part)
          return
        }
        case "tool-call":
          controller.enqueue({ ...part, input: unmaskInput(vault, part.input) })
          return
        case "tool-result":
          controller.enqueue({ ...part, result: vault.unmaskDeep(part.result) })
          return
      }
      controller.enqueue(part)
    },
  })
}

/** The AI SDK middleware: mask what goes out, unmask what comes back. */
export const middleware = (vault: Mask.Vault): LanguageModelV3Middleware => ({
  specificationVersion: "v3",
  async transformParams({ params }) {
    return { ...params, prompt: maskPrompt(vault, params.prompt) }
  },
  async wrapStream({ doStream }) {
    const { stream, ...rest } = await doStream()
    return { ...rest, stream: stream.pipeThrough(unmaskStream(vault)) }
  },
  async wrapGenerate({ doGenerate }) {
    const result = await doGenerate()
    return {
      ...result,
      content: result.content.map((part) => {
        if (part.type === "text" || part.type === "reasoning") return { ...part, text: vault.unmask(part.text) }
        if (part.type === "tool-call") return { ...part, input: unmaskInput(vault, part.input) }
        return part
      }),
    }
  },
})

export * as LLMPrivacy from "./privacy"
