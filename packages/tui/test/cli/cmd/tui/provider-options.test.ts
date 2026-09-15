import { describe, expect, test } from "bun:test"
import { providerOptions } from "../../../../src/component/dialog-provider"
import { createTranslator } from "../../../../src/i18n"

const en = createTranslator("en")

describe("providerOptions", () => {
  test("offers no custom provider entry", () => {
    expect(providerOptions([{ id: "redrob", name: "Redrob" }]).map((option) => option.value)).toEqual(["redrob"])
  })

  test("does not use Other as the generic provider category", () => {
    const option = providerOptions([{ id: "mistral", name: "Mistral" }])[0]
    expect(option?.categoryKey).toBe("provider.category.providers")
    expect(en.t(option!.categoryKey)).toBe("Providers")
  })

  test("keeps popular providers first and sorts the rest alphabetically", () => {
    expect(
      providerOptions([
        { id: "openai", name: "OpenAI" },
        { id: "custom-z", name: "Zebra Provider" },
        { id: "anthropic", name: "Anthropic" },
        { id: "mistral", name: "Mistral" },
        { id: "aws", name: "AWS Bedrock" },
      ]).map((option) => option.value),
    ).toEqual(["openai", "anthropic", "aws", "mistral", "custom-z"])
  })

  test("marks the console provider as recommended", () => {
    const option = providerOptions([{ id: "redrob", name: "Redrob" }])[0]
    expect(option).toMatchObject({
      title: "Redrob",
      descriptionKey: "provider.description.redrob",
      categoryKey: "provider.category.popular",
    })
    expect(en.t(option!.descriptionKey!)).toBe("(Recommended)")
    expect(en.t(option!.categoryKey)).toBe("Popular")
  })
})
