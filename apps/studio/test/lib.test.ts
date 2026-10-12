import { expect, test } from "bun:test"
import { parseUnifiedDiff } from "../src/lib/diff"
import { applyLiveEvent, changesMessages, describeToolInput } from "../src/lib/live"
import { dictionaries, translate } from "../src/i18n"

test("splits a unified diff into files with counts", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    "+new",
    "+more",
    "diff --git a/b.md b/b.md",
    "@@ -0,0 +1 @@",
    "+hello",
  ].join("\n")
  const files = parseUnifiedDiff(diff)
  expect(files.map((file) => [file.path, file.additions, file.deletions])).toEqual([
    ["src/a.ts", 2, 1],
    ["b.md", 1, 0],
  ])
  expect(files[0].lines.map((line) => line.kind)).toEqual(["meta", "hunk", "context", "remove", "add", "add"])
})

test("streams text for one session and clears when the step ends", () => {
  let state = {}
  state = applyLiveEvent(state, { type: "session.next.text.started", data: { sessionID: "s", textID: "t" } }, "s")
  state = applyLiveEvent(
    state,
    { type: "session.next.text.delta", data: { sessionID: "s", textID: "t", delta: "Hel" } },
    "s",
  )
  state = applyLiveEvent(
    state,
    { type: "session.next.text.delta", data: { sessionID: "x", textID: "t", delta: "!" } },
    "s",
  )
  state = applyLiveEvent(
    state,
    { type: "session.next.text.delta", data: { sessionID: "s", textID: "t", delta: "lo" } },
    "s",
  )
  expect(state).toEqual({ t: "Hello" })
  expect(applyLiveEvent(state, { type: "session.next.step.ended", data: { sessionID: "s" } }, "s")).toEqual({})
  expect(changesMessages({ type: "session.next.tool.success", data: { sessionID: "s" } }, "s")).toBe(true)
  expect(changesMessages({ type: "session.next.text.delta", data: { sessionID: "s" } }, "s")).toBe(false)
})

test("describes tool input briefly", () => {
  expect(describeToolInput({ filePath: "src/a.ts", content: "…" })).toBe("src/a.ts")
  expect(describeToolInput({ command: "bun test" })).toBe("bun test")
  expect(describeToolInput(null)).toBe("")
})

test("Korean covers every English key, and placeholders survive", () => {
  expect(Object.keys(dictionaries.ko).sort()).toEqual(Object.keys(dictionaries.en).sort())
  for (const [key, english] of Object.entries(dictionaries.en)) {
    const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    expect(names(dictionaries.ko[key as keyof typeof dictionaries.en])).toEqual(names(english))
  }
  expect(translate("en", "signIn.connected", { account: "Acme" })).toBe("Signed in to Acme")
})
