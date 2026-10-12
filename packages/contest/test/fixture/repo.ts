import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { allText, lastUser, startFakeLlm, type ChatMessage } from "./fake-llm"

/**
 * A small bun project and a scripted set of vendors, shared by the library and CLI tests.
 *
 *   acme  correct `sub` + reproduction test                    -> should win
 *   beta  correct `sub` with a debug print and a TODO          -> lower quality
 *   gamma WRONG `sub` (a + b) + a correct test                 -> its own check regresses
 *   delta, eps  reviewers: prefer the side that subtracts and has no debug print, whatever its position
 */

export const goodTest = (dir: string) =>
  [
    `import { expect, test } from "bun:test"`,
    `import { sub } from "${dir}/math"`,
    `test("sub", () => expect(sub(5, 3)).toBe(2))`,
    "",
  ].join("\n")

function reviewer(messages: ChatMessage[]) {
  const [, first = "", second = ""] = lastUser(messages).split(/## (?:First|Second) candidate/)
  const merit = (part: string) => (/a - b/.test(part) ? 10 : 0) - (/console\.log/.test(part) ? 3 : 0)
  const a = merit(first)
  const b = merit(second)
  const winner = a > b ? "first" : b > a ? "second" : "tie"
  return {
    kind: "text" as const,
    text: JSON.stringify({
      winner,
      confidence: 0.9,
      reasons: ["subtracts", "no debug output"],
      acceptTestChanges: { first: true, second: true },
    }),
  }
}

export function scriptedVendors() {
  return startFakeLlm([
    {
      vendor: "acme",
      reply: () => ({
        kind: "writes",
        files: [
          {
            filePath: "src/math.ts",
            content:
              "export const add = (a: number, b: number) => a + b\nexport const sub = (a: number, b: number) => a - b\n",
          },
          { filePath: "test/sub.test.ts", content: goodTest("../src") },
        ],
      }),
    },
    {
      vendor: "beta",
      reply: () => ({
        kind: "writes",
        files: [
          {
            filePath: "src/math.ts",
            content:
              "export const add = (a: number, b: number) => a + b\n// TODO: tidy this up\nexport function sub(a: number, b: number) {\n  console.log('sub', a, b)\n  const result = a - b\n  return result\n}\n",
          },
          { filePath: "test/subtract.test.ts", content: goodTest("../src") },
        ],
      }),
    },
    {
      vendor: "gamma",
      reply: () => ({
        kind: "writes",
        files: [
          {
            filePath: "src/math.ts",
            content:
              "export const add = (a: number, b: number) => a + b\nexport const sub = (a: number, b: number) => a + b\n",
          },
          { filePath: "test/minus.test.ts", content: goodTest("../src") },
        ],
      }),
    },
    { vendor: "delta", reply: reviewer },
    { vendor: "eps", reply: reviewer },
  ])
}

export const VENDORS = ["acme", "beta", "gamma", "delta", "eps"]

export function createRepo(repo: string, llm: { url: (vendor: string) => string }) {
  mkdirSync(path.join(repo, "src"), { recursive: true })
  mkdirSync(path.join(repo, "test"), { recursive: true })
  const provider = (vendor: string) => ({
    name: vendor,
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: llm.url(vendor), apiKey: "test" },
    models: { coder: { name: `${vendor} coder`, tool_call: true } },
  })
  writeFileSync(
    path.join(repo, "redrob.json"),
    JSON.stringify(
      {
        provider: Object.fromEntries(VENDORS.map((vendor) => [vendor, provider(vendor)])),
        permission: { "*": "allow" },
      },
      null,
      2,
    ),
  )
  writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify(
      { name: "demo", private: true, packageManager: "bun@1.3.14", scripts: { test: "bun test" } },
      null,
      2,
    ),
  )
  writeFileSync(path.join(repo, "src", "math.ts"), "export const add = (a: number, b: number) => a + b\n")
  writeFileSync(
    path.join(repo, "test", "add.test.ts"),
    goodTest("../src").replaceAll("sub", "add").replace("toBe(2)", "toBe(8)"),
  )
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo })
  git("init", "-q", "-b", "main")
  git("add", ".")
  git("commit", "-qm", "Initial math")
}

export { allText }
