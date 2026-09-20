import { describe, expect, test } from "bun:test"
import { isLocalApi, modelsUrl } from "@redrob-code/core/config/plugin/local-models"
import { LOCAL_PROVIDER_PACKAGE } from "@redrob-code/core/config/plugin/local-provider"

describe("modelsUrl", () => {
  test("joins whether or not the base ends in a slash", () => {
    // Both spellings appear in real config files, and a doubled slash is a 404 on some runtimes.
    expect(modelsUrl("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434/v1/models")
    expect(modelsUrl("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434/v1/models")
    expect(modelsUrl("http://127.0.0.1:11434/v1///")).toBe("http://127.0.0.1:11434/v1/models")
  })
})

describe("isLocalApi", () => {
  const local = { type: "aisdk", package: LOCAL_PROVIDER_PACKAGE, url: "http://127.0.0.1:11434/v1" }

  test("accepts a local runtime on the trusted package", () => {
    expect(isLocalApi(local)).toBe(true)
  })

  test("refuses a public address, so this cannot become a way to call an arbitrary host on startup", () => {
    /*
      The whole reason this check is repeated here rather than inherited: the plugin makes an OUTBOUND
      request built from a config file. Trusting that the provider was gated on the way in would mean a
      later change to that gate silently changes what the CLI connects to at boot.
    */
    expect(isLocalApi({ ...local, url: "https://evil.example/v1" })).toBe(false)
  })

  test("refuses any other package", () => {
    expect(isLocalApi({ ...local, package: "@ai-sdk/openai" })).toBe(false)
  })

  test("refuses a native api block", () => {
    expect(isLocalApi({ type: "native", url: "http://127.0.0.1:11434/v1" })).toBe(false)
  })

  test("refuses a missing url rather than defaulting anywhere", () => {
    expect(isLocalApi({ type: "aisdk", package: LOCAL_PROVIDER_PACKAGE })).toBe(false)
  })
})
