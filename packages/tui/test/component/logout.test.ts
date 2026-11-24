import { describe, expect, test } from "bun:test"
import { externalSignIn, logoutTargets } from "../../src/component/logout"

const all = [
  { id: "redrob", name: "Redrob", source: "api" },
  { id: "openai", name: "OpenAI", source: "api" },
  { id: "anthropic", name: "Anthropic", source: "env" },
]

describe("logoutTargets", () => {
  test("offers connected providers whose key this app stored", () => {
    expect(logoutTargets({ all, connected: ["redrob"], consoleManaged: [] }).map((x) => x.id)).toEqual(["redrob"])
  })

  test("leaves out console-managed providers, which have no local sign-in", () => {
    const targets = logoutTargets({ all, connected: ["redrob", "openai"], consoleManaged: new Set(["openai"]) })
    expect(targets.map((x) => x.id)).toEqual(["redrob"])
  })

  test("leaves out keyless Redrob, which still lists as connected", () => {
    const keyless = [{ id: "redrob", name: "Redrob", source: "custom" }]
    expect(logoutTargets({ all: keyless, connected: ["redrob"], consoleManaged: [] })).toEqual([])
  })

  test("leaves out keys from REDROB_API_KEY or Redrob Desktop", () => {
    const shared = [
      { id: "redrob", name: "Redrob", source: "launcher" },
      { id: "anthropic", name: "Anthropic", source: "env" },
    ]
    expect(logoutTargets({ all: shared, connected: ["redrob", "anthropic"], consoleManaged: [] })).toEqual([])
  })
})

describe("externalSignIn", () => {
  test("finds a connected provider signed in through the environment or Redrob Desktop", () => {
    const shared = [{ id: "redrob", name: "Redrob", source: "launcher" }]
    expect(externalSignIn(shared, ["redrob"])?.id).toBe("redrob")
  })

  test("ignores stored and keyless providers", () => {
    expect(externalSignIn([{ id: "redrob", name: "Redrob", source: "api" }], ["redrob"])).toBeUndefined()
    expect(externalSignIn([{ id: "redrob", name: "Redrob", source: "custom" }], ["redrob"])).toBeUndefined()
  })
})
