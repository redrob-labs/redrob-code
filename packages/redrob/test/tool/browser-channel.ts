import { BrowserRequestV1 } from "@redrob-code/core/browser-request"
import { Effect, Layer } from "effect"

/**
 * PA-10 test double for the browser channel.
 *
 * Shared because four suites build the real code-mode tool, and that tool now resolves
 * `page` through this service. Without it they fail to construct rather than failing an
 * assertion, which is a worse signal.
 *
 * `ask` fails immediately instead of sleeping to the service's real deadline. The deadline
 * is tested where it lives (`packages/core/test/browser-request.test.ts`); paying 20 seconds
 * for it in every suite that merely needs the tool to exist would buy nothing.
 */
export function unansweredBrowser(): BrowserRequestV1.Interface {
  return {
    ask: (input) => Effect.fail(new BrowserRequestV1.UnansweredError({ action: input.command.action })),
    reply: () => Effect.void,
    refuse: () => Effect.void,
    list: () => Effect.succeed([]),
  }
}

/** The layer form, for a harness that just needs the service present. */
export function unansweredBrowserLayer() {
  return Layer.mock(BrowserRequestV1.Service, unansweredBrowser())
}
