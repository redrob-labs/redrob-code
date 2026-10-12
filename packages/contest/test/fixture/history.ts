import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { lastUser, startFakeLlm, type ChatMessage } from "./fake-llm"
import { VENDORS } from "./repo"

/**
 * A repository with a history to replay: two real fixes that each came with a test, and one commit
 * with no test (which must not become a task). Builders and reviewers are scripted per task.
 */

const ADD = "export const add = (a: number, b: number) => a + b\n"
const SUB = "export const subtract = (a: number, b: number) => a - b\n"
const MUL = "export const multiply = (a: number, b: number) => a * b\n"

const test = (name: string, call: string, expected: number) =>
  `import { expect, test } from "bun:test"\nimport { ${name} } from "../src/math"\ntest("${name}", () => expect(${call}).toBe(${expected}))\n`

/** Which task this is, read from the task itself: a reviewer prompt's diffs mention both functions. */
const isSub = (messages: ChatMessage[]) => {
  const text = lastUser(messages)
  const task = /# Task\s+([\s\S]*?)(\n#|$)/.exec(text)?.[1] ?? text.split("---")[0] ?? text
  return /subtract/i.test(task)
}

function builder(kind: "clean" | "messy" | "wrong") {
  return (messages: ChatMessage[]) => {
    const sub = isSub(messages)
    const correct = sub ? SUB : MUL
    const wrong = sub
      ? "export const subtract = (a: number, b: number) => a + b\n"
      : "export const multiply = (a: number, b: number) => a + b\n"
    const fn =
      kind === "wrong"
        ? wrong
        : kind === "messy"
          ? `// TODO: tidy\n${correct.replace("=>", "=> { console.log('x'); return").replace(/\n$/, " }\n")}`
          : correct
    const before = sub ? ADD : ADD + SUB
    return {
      kind: "writes" as const,
      files: [
        { filePath: "src/math.ts", content: before + fn },
        {
          filePath: `test/${kind}-${sub ? "sub" : "mul"}.test.ts`,
          content: sub ? test("subtract", "subtract(5, 3)", 2) : test("multiply", "multiply(4, 3)", 12),
        },
      ],
    }
  }
}

/** Prefers the side whose diff has the right operator, then the tidier one; position never matters. */
function reviewer(messages: ChatMessage[]) {
  const text = lastUser(messages)
  const [, first = "", second = ""] = text.split(/## (?:First|Second) candidate/)
  const right = isSub(messages) ? /a - b/ : /a \* b/
  const merit = (part: string) => {
    const added = part.split("\n").filter((line) => line.startsWith("+"))
    let value = added.some((line) => right.test(line)) ? 10 : 0
    if (added.some((line) => /console\.log/.test(line))) value -= 3
    if (added.some((line) => /TODO/.test(line))) value -= 1
    if (added.some((line) => /\.skip\(/.test(line))) value -= 5
    for (let i = 1; i < added.length; i++) if (added[i] === added[i - 1] && added[i]!.trim().length > 1) value -= 3
    if (added.some((line) => /a \+ b/.test(line) && /subtract|multiply/.test(line))) value -= 10
    return value
  }
  const a = merit(first)
  const b = merit(second)
  return {
    kind: "text" as const,
    text: JSON.stringify({
      winner: a > b ? "first" : b > a ? "second" : "tie",
      confidence: 0.8,
      reasons: [],
      acceptTestChanges: { first: true, second: true },
    }),
  }
}

export function historyVendors() {
  return startFakeLlm([
    { vendor: "acme", reply: builder("clean") },
    { vendor: "beta", reply: builder("messy") },
    { vendor: "gamma", reply: builder("wrong") },
    { vendor: "delta", reply: reviewer },
    { vendor: "eps", reply: reviewer },
  ])
}

export function createHistoryRepo(repo: string, llm: { url: (vendor: string) => string }) {
  mkdirSync(path.join(repo, "src"), { recursive: true })
  mkdirSync(path.join(repo, "test"), { recursive: true })
  const provider = (vendor: string) => ({
    name: vendor,
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: llm.url(vendor), apiKey: "test" },
    models: { coder: { name: `${vendor} coder`, tool_call: true } },
  })
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=Human", "-c", "user.email=h@example.com", ...args], { cwd: repo })
  const commit = (message: string) => {
    git("add", "-A")
    git("commit", "-qm", message)
  }

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
      { name: "history", private: true, packageManager: "bun@1.3.14", scripts: { test: "bun test" } },
      null,
      2,
    ),
  )
  writeFileSync(path.join(repo, "src", "math.ts"), ADD)
  writeFileSync(path.join(repo, "test", "add.test.ts"), test("add", "add(4, 4)", 8))
  git("init", "-q", "-b", "main")
  commit("Add the math module")

  writeFileSync(path.join(repo, "src", "math.ts"), ADD + SUB)
  writeFileSync(path.join(repo, "test", "subtract.test.ts"), test("subtract", "subtract(10, 4)", 6))
  commit("Add subtract\n\nAdd a subtract(a, b) function to src/math.ts that returns a minus b, with a test.")

  writeFileSync(path.join(repo, "README.md"), "# history\n")
  commit("Add a readme")

  writeFileSync(path.join(repo, "src", "math.ts"), ADD + SUB + MUL)
  writeFileSync(path.join(repo, "test", "multiply.test.ts"), test("multiply", "multiply(6, 7)", 42))
  commit("Add multiply\n\nAdd a multiply(a, b) function to src/math.ts that returns a times b, with a test.")
}
