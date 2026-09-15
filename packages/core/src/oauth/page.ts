// Branded HTML pages for local OAuth callback servers.
//
// These are served by the loopback HTTP servers that finish an OAuth exchange
// (MCP, Codex/ChatGPT, xAI, Snowflake, DigitalOcean, ...). The functions return
// a fully self-contained HTML string with no external assets, so they work
// offline and drop into any transport (`res.end(...)`, Effect `response.end`,
// etc.).
//
// This is the one Redrob Code surface a browser renders, so it is the one that can share the
// console's token system as tokens: the roles below are the console's semantic names and the values
// are the brand primitives from `../theme/brand`. The wordmark is the shared Redrob Code geometry.
// This file is the source of record for both; the browser UI packages that used to hold them live in
// Redrob Work.
//
// Pretendard is named in the font stack and deliberately not fetched. The page must work offline -
// a failed authorization is exactly when the network is not there - and a blocking webfont request
// from a loopback page would trade the whole card for the typeface. Anyone with Pretendard installed
// sees it; everyone else gets the system stack, whose metrics are close enough that the difference is
// weight, not layout. The console loads the webfont because it is a hosted site and can.
import { Brand } from "../theme/brand"

export interface CallbackPageOptions {
  /** Friendly integration name shown as a subtitle, e.g. "xAI", "Snowflake", "MCP". */
  provider?: string
  /** Attempt to close the window shortly after success. Defaults to true. */
  autoClose?: boolean
}

export function success(options?: CallbackPageOptions) {
  const provider = options?.provider
  return renderDocument({
    title: "Authorization successful",
    body: renderCard({
      status: "success",
      headline: "Authorization successful",
      message: provider ? `RedrobCode is now connected to ${escapeHtml(provider)}.` : "RedrobCode is now authorized.",
      footnote: "You can close this window.",
    }),
    script: options?.autoClose === false ? undefined : AUTO_CLOSE_SCRIPT,
  })
}

export function error(detail: string, options?: CallbackPageOptions) {
  const provider = options?.provider
  return renderDocument({
    title: "Authorization failed",
    body: renderCard({
      status: "error",
      headline: "Authorization failed",
      message: provider
        ? `RedrobCode couldn't finish connecting to ${escapeHtml(provider)}.`
        : "RedrobCode couldn't complete authorization.",
      detail,
      footnote: "Close this window and try again from RedrobCode.",
    }),
  })
}

export interface BootstrapOptions {
  /** Same-origin path the in-browser script POSTs the parsed callback to. */
  tokenPath: string
  provider?: string
}

// For flows where the credential arrives in the URL fragment (implicit grant),
// the browser must relay it back to the loopback server. This renders a pending
// page whose script reads the fragment, POSTs it to `tokenPath`, then resolves
// to the success or error state in place.
export function bootstrap(options: BootstrapOptions) {
  return renderDocument({
    title: "Finishing sign-in",
    body: renderCard({
      status: "pending",
      headline: "Finishing sign-in",
      message: options.provider
        ? `Completing your ${escapeHtml(options.provider)} authorization.`
        : "Completing authorization.",
      footnote: "You can close this window once sign-in finishes.",
    }),
    script: bootstrapScript(options),
  })
}

export * as OauthCallbackPage from "./page"

type Status = "pending" | "success" | "error"

function renderCard(input: { status: Status; headline: string; message: string; detail?: string; footnote: string }) {
  const detail = input.detail?.trim()
  return `<main class="card" id="rr-card" data-status="${input.status}" role="status" aria-live="polite">
      <div class="brand">${WORDMARK}</div>
      <div class="status" aria-hidden="true">
        <span class="icon icon-pending">${ICON_SPINNER}</span>
        <span class="icon icon-success">${ICON_CHECK}</span>
        <span class="icon icon-error">${ICON_CROSS}</span>
      </div>
      <h1 class="headline" id="rr-headline">${escapeHtml(input.headline)}</h1>
      <p class="message" id="rr-message">${input.message}</p>
      <pre class="detail" id="rr-detail"${detail ? "" : " hidden"}>${detail ? escapeHtml(detail) : ""}</pre>
      <p class="footnote" id="rr-footnote">${escapeHtml(input.footnote)}</p>
    </main>`
}

function renderDocument(input: { title: string; body: string; script?: string }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(input.title)} · RedrobCode</title>
    <style>${STYLES}</style>
  </head>
  <body>
    ${input.body}${input.script ? `\n    <script>${input.script}</script>` : ""}
  </body>
</html>`
}

const AUTO_CLOSE_SCRIPT = `setTimeout(function(){try{window.close()}catch(e){}},2500)`

function bootstrapScript(options: BootstrapOptions) {
  return `var PROVIDER=${scriptString(options.provider ?? "")};
var TOKEN_URL=new URL(${scriptString(options.tokenPath)},window.location.origin).href;
(function(){
  var card=document.getElementById("rr-card"),headline=document.getElementById("rr-headline"),message=document.getElementById("rr-message"),detail=document.getElementById("rr-detail"),footnote=document.getElementById("rr-footnote");
  function fail(text){card.dataset.status="error";headline.textContent="Authorization failed";message.textContent=PROVIDER?("RedrobCode couldn't finish connecting to "+PROVIDER+"."):"RedrobCode couldn't complete authorization.";if(text){detail.textContent=text;detail.hidden=false}footnote.textContent="Close this window and try again from RedrobCode."}
  function ok(){card.dataset.status="success";headline.textContent="Authorization successful";message.textContent=PROVIDER?("RedrobCode is now connected to "+PROVIDER+"."):"RedrobCode is now authorized.";detail.hidden=true;footnote.textContent="You can close this window.";setTimeout(function(){try{window.close()}catch(e){}},2500)}
  try{
    var hash=new URLSearchParams((window.location.hash||"").slice(1));
    var search=new URLSearchParams(window.location.search||"");
    var err=hash.get("error")||search.get("error");
    var errDescription=hash.get("error_description")||search.get("error_description");
    var body=err?{error:err,error_description:errDescription||""}:{access_token:hash.get("access_token")||"",expires_in:hash.get("expires_in")||"0",state:hash.get("state")||""};
    fetch(TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(res){
      if(!res.ok)return res.text().catch(function(){return""}).then(function(t){throw new Error(t||("callback failed ("+res.status+")"))});
      if(err){fail(errDescription||err);return}
      ok();
    }).catch(function(e){fail(String(e&&e.message?e.message:e))});
  }catch(e){fail(String(e&&e.message?e.message:e))}
})()`
}

function scriptString(value: string) {
  return JSON.stringify(value).replaceAll("<", "\\u003c")
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

// Curated subset of the Redrob Console semantic tokens, pointed at the brand primitives in
// `../theme/brand`. Role names follow the console's stylesheet so the two surfaces speak one
// vocabulary; the values are the same steps. Default is light and dark applies via
// prefers-color-scheme. The [data-theme] selectors let a host force a scheme without changing the
// default.
//
// Where this departs from the console, and why:
//
//   - `--rr-card` on dark is the console's `color-mix(in srgb, var(--rr-gray-8) 45%, var(--rr-gray-9))`
//     resolved to hex by `Brand.mix`. Written out rather than mixed in CSS so the value is the one
//     the contrast test reads.
//   - `--rr-subtle-foreground` is Gray 6 in both themes, as on the console, and is used only for the
//     footnote and the pending icon: 3.8:1 on the light card clears large text and non-text UI and
//     does not clear body copy.
//   - The detail block is only ever an error payload, so it takes `destructive-soft` for its strip
//     and `destructive` for its boundary instead of inventing a warm tint.
const LIGHT_VARS = `
    --rr-bg: ${Brand.gray1};
    --rr-card: ${Brand.white};
    --rr-foreground: ${Brand.gray9};
    --rr-muted-foreground: ${Brand.gray7};
    --rr-subtle-foreground: ${Brand.gray6};
    --rr-border: ${Brand.gray3};
    --rr-primary: ${Brand.blue6};
    --rr-icon-strong: ${Brand.gray9};
    --rr-icon-base: ${Brand.gray7};
    --rr-icon-weak: ${Brand.gray3};
    --rr-success-ink: ${Brand.green5};
    --rr-destructive-ink: ${Brand.red4};
    --rr-destructive: ${Brand.red4};
    --rr-destructive-soft: ${Brand.red1};
    --rr-shadow: 0 2px 4px color-mix(in srgb, ${Brand.gray8} 6%, transparent), 0 12px 32px color-mix(in srgb, ${Brand.gray8} 12%, transparent);`

const DARK_VARS = `
    --rr-bg: ${Brand.gray9};
    --rr-card: ${Brand.mix(Brand.gray8, Brand.gray9, 0.45)};
    --rr-foreground: ${Brand.gray1};
    --rr-muted-foreground: ${Brand.gray5};
    --rr-subtle-foreground: ${Brand.gray6};
    --rr-border: ${Brand.gray8};
    --rr-primary: ${Brand.blue5};
    --rr-icon-strong: ${Brand.gray1};
    --rr-icon-base: ${Brand.gray5};
    --rr-icon-weak: ${Brand.gray8};
    --rr-success-ink: ${Brand.green3};
    --rr-destructive-ink: ${Brand.red3};
    --rr-destructive: ${Brand.red3};
    --rr-destructive-soft: ${Brand.red5};
    --rr-shadow: 0 2px 4px color-mix(in srgb, ${Brand.black} 30%, transparent), 0 12px 32px color-mix(in srgb, ${Brand.black} 50%, transparent);`

const STYLES = `
  :root { color-scheme: light dark;${LIGHT_VARS}
    --rr-font-sans: ${Brand.fontSans};
    --rr-font-mono: ${Brand.fontMono};
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${DARK_VARS} } }
  :root[data-theme="dark"] {${DARK_VARS} }
  :root[data-theme="light"] {${LIGHT_VARS} }

  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--rr-bg);
    color: var(--rr-muted-foreground);
    font-family: var(--rr-font-sans);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  /* Korean lines break between any two syllables by default, so a wrap lands mid-word and the reader
     has to reassemble it. Break on spaces instead, the way Korean is typeset. A provider name or an
     error payload can arrive in Korean on an English page, so this is set on everything; Latin has no
     soft wrap opportunity between letters to suppress, so it is inert for English. */
  * { word-break: keep-all; overflow-wrap: break-word; }
  :lang(zh), :lang(ja) { word-break: normal; line-break: strict; }
  .card {
    width: min(100%, 28rem);
    padding: 2.25rem 2rem 1.75rem;
    background: var(--rr-card);
    border: 1px solid var(--rr-border);
    border-radius: ${Brand.radiusLg};
    box-shadow: var(--rr-shadow);
    text-align: center;
  }
  .brand { display: flex; justify-content: center; margin-bottom: 1.75rem; }
  .brand svg { height: 19px; width: auto; }
  .status { display: flex; justify-content: center; margin-bottom: 1.125rem; }
  .icon { display: none; line-height: 0; }
  .icon svg { display: block; }
  .card[data-status="pending"] .icon-pending,
  .card[data-status="success"] .icon-success,
  .card[data-status="error"] .icon-error { display: block; }
  .icon-success { color: var(--rr-success-ink); }
  .icon-error { color: var(--rr-destructive-ink); }
  .icon-pending { color: var(--rr-primary); }
  .headline { margin: 0; font-size: 1.1875rem; font-weight: 500; line-height: 1.3; letter-spacing: -0.012em; color: var(--rr-foreground); }
  .message { margin: 0.5rem 0 0; font-size: 0.9375rem; color: var(--rr-muted-foreground); }
  .detail {
    margin: 1.25rem 0 0;
    padding: 0.75rem 0.875rem;
    text-align: left;
    font-family: var(--rr-font-mono);
    font-size: 0.8125rem;
    line-height: 1.55;
    color: var(--rr-foreground);
    background: var(--rr-destructive-soft);
    border: 1px solid var(--rr-destructive);
    border-radius: ${Brand.radiusSm};
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 9.5rem;
    overflow: auto;
  }
  .detail[hidden] { display: none; }
  .footnote { margin: 1.5rem 0 0; font-size: 0.8125rem; color: var(--rr-subtle-foreground); }
  .spinner { animation: rr-spin 0.8s linear infinite; transform-origin: center; }
  @keyframes rr-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
`

// RedrobCode wordmark.
const WORDMARK = `<svg class="wordmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 234 42" fill="none" aria-label="RedrobCode" role="img">
        <path d="M18 30H6V18H18V30Z" fill="var(--rr-icon-weak)" />
        <path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" fill="var(--rr-icon-base)" />
        <path d="M48 30H36V18H48V30Z" fill="var(--rr-icon-weak)" />
        <path d="M36 30H48V12H36V30ZM54 36H36V42H30V6H54V36Z" fill="var(--rr-icon-base)" />
        <path d="M84 24V30H66V24H84Z" fill="var(--rr-icon-weak)" />
        <path d="M84 24H66V30H84V36H60V6H84V24ZM66 18H78V12H66V18Z" fill="var(--rr-icon-base)" />
        <path d="M108 36H96V18H108V36Z" fill="var(--rr-icon-weak)" />
        <path d="M108 12H96V36H90V6H108V12ZM114 36H108V12H114V36Z" fill="var(--rr-icon-base)" />
        <path d="M144 30H126V18H144V30Z" fill="var(--rr-icon-weak)" />
        <path d="M144 12H126V30H144V36H120V6H144V12Z" fill="var(--rr-icon-strong)" />
        <path d="M168 30H156V18H168V30Z" fill="var(--rr-icon-weak)" />
        <path d="M168 12H156V30H168V12ZM174 36H150V6H174V36Z" fill="var(--rr-icon-strong)" />
        <path d="M198 30H186V18H198V30Z" fill="var(--rr-icon-weak)" />
        <path d="M198 12H186V30H198V12ZM204 36H180V6H198V0H204V36Z" fill="var(--rr-icon-strong)" />
        <path d="M234 24V30H216V24H234Z" fill="var(--rr-icon-weak)" />
        <path d="M216 12V18H228V12H216ZM234 24H216V30H234V36H210V6H234V24Z" fill="var(--rr-icon-strong)" />
      </svg>`

const ICON_CHECK = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.4 2.4 4.6-5.4" /></svg>`

const ICON_CROSS = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></svg>`

const ICON_SPINNER = `<svg class="spinner" viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9" opacity="0.2" /><path d="M21 12a9 9 0 0 0-9-9" /></svg>`
