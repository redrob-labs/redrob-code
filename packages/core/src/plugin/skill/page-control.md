# Reading and driving the page in code mode

Use this when the task is about the page the user is looking at: read it, find things in
it, fill a field, click, or follow a link. In code mode you write a program and the `page`
global is in scope.

## What exists

Six calls. There is no seventh — if you need something else, say so rather than inventing
a call that will not resolve.

```ts
await page.url()                                    // string — the current URL
await page.text()                                   // string — the visible text
await page.query({ selector, limit })               // PageNode[] — in document order
await page.click({ selector })                      // void
await page.type({ selector, text, submit })         // void
await page.navigate({ url })                        // string — the URL actually landed on
```

A `PageNode` is `{ selector, text, attributes }`. It is a snapshot, not a handle: you
cannot hold one and act on it later. Act by selector.

## Where the page is

Not in this process. The engine runs beside the browser and cannot reach into it, so each
call is a request the browser answers. Three consequences, all of which you will meet:

1. **Every call can refuse.** When no browser is attached, the call fails with
   `DomainUnavailableError` and the message names the action. That is the honest answer, not
   a bug to work around. Tell the user the browser is not attached.
2. **A refusal is also the answer for a tab the user has not exposed**, and for the
   browser's own pages (`chrome://`, the extension's pages). You cannot read those, and
   nothing you write will change that.
3. **Each call is a round trip.** Three queries cost three round trips. Prefer one
   `page.text()` over ten `page.query()` calls when you only need to read, and one
   `page.query()` with a `limit` over a loop.

## Reading before acting

`page.text()` is the cheapest way to see what is on screen, and it is usually enough to
answer a question about the page. Reach for `page.query()` when you need structure — the
href of each link, the value of an attribute, which of several forms is which.

```ts
const links = await page.query({ selector: "a[href]", limit: 50 })
const external = links.filter((node) => !node.attributes.href?.startsWith("/"))
```

`query` returns `[]` when the selector matched nothing. That is a fact about the page, and
it is different from a refusal, which is a fact about the session. Do not treat an empty
array as "no browser" — check the error path for that.

## Filling a field

`page.type` targets the first node matching the selector and types into it. `submit: true`
submits the form afterwards, which is one round trip instead of a type and a click.

```ts
await page.type({ selector: "input[name=q]", text: "redrob", submit: true })
```

Type into the field, not into its wrapper: a selector that matches a `div` around the input
has nothing to receive text. Pick the `input`, `textarea` or `[contenteditable]` itself,
and confirm with `page.query` first when the markup is unfamiliar.

## Navigating

`page.navigate` returns the URL actually landed on, which is frequently not the one you
asked for — a redirect, a login wall, a trailing-slash normalisation. Read the return value
before assuming you are where you aimed.

```ts
const landed = await page.navigate({ url: "https://example.com/report" })
if (!landed.includes("/report")) {
  // A login wall or a redirect. Say so; do not keep clicking.
}
```

## What not to do

Do not poll. There is no wait call, and a loop of `page.text()` until something changes
is a round trip per iteration against a page that may never change. Read once, act, read
once more.

Do not scrape a credential. The page the user is on may be signed in; reading a token out
of it and putting it in your answer or a file is an exfiltration, not a task step.

Do not guess at a selector you have not seen. One `page.query({ selector: "form", limit: 5
})` costs one round trip and tells you the shape; a wrong selector costs a refusal and a
confused user.
