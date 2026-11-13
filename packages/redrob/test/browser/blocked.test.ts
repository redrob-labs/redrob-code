import { afterEach, describe, expect, test } from "bun:test"
import { BlockedPage } from "../../src/browser/blocked"
import { UserBrowser } from "../../src/browser/extension"
import BROWSER from "../../src/tool/browser.txt"
import WEBSEARCH from "../../src/tool/websearch.txt"

afterEach(() => UserBrowser.reset())

describe("BlockedPage.blocked", () => {
  const cases: Array<[string, string, string]> = [
    ["Access Denied", "- heading \"Access Denied\" [level=1]\n- text: You don't have permission to access", "Access Denied"],
    ["403 Forbidden", "- heading \"403 Forbidden\"", "403 Forbidden"],
    ["Just a moment...", "- text: Checking your browser before accessing", "a Cloudflare check"],
    ["", "- text: Please complete the CAPTCHA to continue", "a captcha"],
    ["Robot check", "- text: Are you a robot?", "a robot check"],
    ["네이버", "- text: 자동입력 방지 문자를 입력해 주세요", "a captcha"],
    ["Pardon Our Interruption", "- text: something about your browser", "a block page"],
  ]
  for (const [title, text, sign] of cases)
    test(`sees ${sign} (${title || text.slice(0, 20)})`, () => {
      expect(BlockedPage.blocked({ title, text })).toBe(sign)
    })

  test("the site itself is not a block, even a long page that mentions a captcha", () => {
    expect(BlockedPage.blocked({ title: "쿠팡! | 에어팟 프로 3", text: "- link \"에어팟 프로 3\"\n- text: 329,000원" })).toBeUndefined()
    expect(BlockedPage.blocked({ title: "Example Domain", text: "This domain is for use in documentation examples." })).toBeUndefined()
    const long = `${"- text: product row\n".repeat(300)}- text: we use reCAPTCHA on sign-in`
    expect(BlockedPage.blocked({ title: "Shop", text: long })).toBeUndefined()
  })
})

describe("a blocked page in the built-in browser", () => {
  const page = { url: "https://www.coupang.com/np/search?q=airpods", title: "Access Denied", text: "- heading \"Access Denied\"" }
  const off = async () => ({ state: "none" as const })

  test("says the site blocked it, tells the model to say so, and how to connect once per session", async () => {
    const first = await UserBrowser.onBlocked(page, { sessionID: "ses_b", observe: off })
    expect(first && "note" in first).toBe(true)
    if (!first || !("note" in first)) return
    expect(first.note.startsWith("Blocked: www.coupang.com showed Access Denied")).toBe(true)
    expect(first.note).toContain("the answer comes from search results, not from www.coupang.com")
    expect(first.note).toContain(UserBrowser.CONNECT)
    expect(first.connect).toBe(true)
    const again = await UserBrowser.onBlocked(page, { sessionID: "ses_b", observe: off })
    if (!again || !("note" in again)) throw new Error("expected a note")
    expect(again.note).not.toContain(UserBrowser.CONNECT)
    expect(again.connect).toBe(false)
  })

  test("a page that is the site gets nothing", async () => {
    expect(await UserBrowser.onBlocked({ ...page, title: "쿠팡", text: "- text: 329,000원" }, { sessionID: "ses_c", observe: off })).toBeUndefined()
  })

  test("retries in the person's Chrome when it is linked", async () => {
    const answer = "URL: https://www.coupang.com/np/search?q=airpods\nTitle: 쿠팡\n\n- text: 329,000원"
    let n = 0
    const ask = async (request: { method: string; path: string }) => {
      if (request.path.startsWith("/browser/task?chatId=")) return { status: 404, browser: { state: "ready" as const, name: "Chrome" } }
      if (request.method === "POST") return { status: 200, body: { id: `t${++n}` }, browser: { state: "ready" as const, name: "Chrome" } }
      return { status: 200, body: { id: "t1", state: "done", events: [], answer }, browser: { state: "ready" as const, name: "Chrome" } }
    }
    const result = await UserBrowser.onBlocked(page, {
      sessionID: "ses_r",
      ask,
      observe: async () => ({ state: "ready" as const, name: "Chrome" }),
    })
    expect(result && "retried" in result && result.retried.text).toBe(answer)
  })
})

describe("the tool descriptions", () => {
  test("the browser tool is for shops, bookings, sign-ins and bot checks, and a block is said", () => {
    expect(BROWSER).toContain("prices and stock in a shop, bookings, anything behind a sign-in, or a site with a bot check")
    expect(BROWSER).toContain("the answer comes from search results, not from the site")
  })

  test("web search says snippets are not the site, and to say so", () => {
    expect(WEBSEARCH).toContain("use the browser tool")
    expect(WEBSEARCH).toContain("the answer comes from search results, not from the site")
  })
})
