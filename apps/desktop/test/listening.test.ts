import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { SERVER_LISTENING_PREFIX, createLineScanner, parseListeningUrl } from "../src/main/listening"

test("the prefix is the one serve.ts prints", () => {
  // Duplicated rather than imported (see listening.ts). This is what keeps the copy honest: a reworded
  // line would hang the app at startup with nothing to read.
  const serve = readFileSync(path.resolve(import.meta.dir, "../../../packages/redrob/src/cli/cmd/serve.ts"), "utf8")
  expect(serve).toContain(`export const SERVER_LISTENING_PREFIX = "${SERVER_LISTENING_PREFIX}"`)
})

test("parses the url and ignores everything else", () => {
  expect(parseListeningUrl("redrob server listening on http://127.0.0.1:51234")).toBe("http://127.0.0.1:51234")
  expect(parseListeningUrl("Warning: REDROB_SERVER_PASSWORD is not set; server is unsecured.")).toBeNull()
})

test("finds the line across chunk boundaries, once", () => {
  const urls: string[] = []
  const scan = createLineScanner((url) => urls.push(url))
  scan("booting\nredrob server list")
  scan("ening on http://127.0.0.1:4")
  scan("096\nredrob server listening on http://127.0.0.1:9\n")
  expect(urls).toEqual(["http://127.0.0.1:4096"])
})
