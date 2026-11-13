/**
 * Whether a page is a bot check or an access block rather than the site itself: shops and
 * ticketing sites (Coupang, for one) answer a headless browser with "Access Denied", a 403, a
 * captcha or a Cloudflare challenge. Read from the page's title and the start of its text only;
 * a long page that merely mentions a captcha is the site.
 */
const SIGNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\baccess denied\b/i, "Access Denied"],
  [/\b403\b.{0,20}\bforbidden\b|\bforbidden\b.{0,20}\b403\b|^\s*403\b/i, "403 Forbidden"],
  [/just a moment|checking your browser|cf-chl|attention required.{0,20}cloudflare|cloudflare ray id/i, "a Cloudflare check"],
  [/\bcaptcha\b|recaptcha|hcaptcha|보안 ?문자|자동입력 ?방지/i, "a captcha"],
  [/are you (?:a )?(?:human|robot)|not a robot|verify (?:you are|that you're) (?:a )?human|unusual traffic|로봇이 아닙니다/i, "a robot check"],
  [/request (?:was )?blocked|pardon our interruption|bot detected|접근이 (?:차단|거부)/i, "a block page"],
]

/** Only a page this short can be a block page; the site's own pages are longer. */
const MAX_BLOCK_TEXT = 3_000

/** What blocked the page ("Access Denied", "a captcha", ...), or undefined when it is the site. */
export function blocked(page: { readonly title: string; readonly text: string }): string | undefined {
  const text = page.text.length > MAX_BLOCK_TEXT ? undefined : page.text
  for (const [sign, name] of SIGNS) {
    if (sign.test(page.title)) return name
    if (text !== undefined && sign.test(text)) return name
  }
  return undefined
}

export * as BlockedPage from "./blocked"
