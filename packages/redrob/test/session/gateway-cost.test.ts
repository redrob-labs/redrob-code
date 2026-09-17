import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The gateway cost figure reaching the engine.
 *
 * This shipped broken once, in a release I reported as fixing it, so the chain is pinned link by link. The
 * console returns `redrob.costUsd`: the amount the account was actually debited, which local arithmetic
 * cannot reproduce because `auto` is billed at the ROUTED model's rate, a long-context rate applies past
 * each model's own boundary, and the priority tier is 1.75x.
 *
 * Two separate links were missing and each one alone was enough to lose the value:
 *
 *  1. The stream event schema declared only `choices` and `usage`. A schema that does not name a field
 *     DROPS it, so the sibling `redrob` block never survived parsing.
 *  2. `getUsage` reads the EVENT's `providerMetadata`, while the protocol only ever populated the USAGE
 *     object's. Even once parsed, the block sat one level too deep to be read.
 *
 * Source assertions rather than a live call, because the behaviour needs a console with credit and a real
 * key; what these guard is that neither link can be quietly removed again.
 */
const protocol = readFileSync(
  join(import.meta.dir, "..", "..", "..", "llm", "src", "protocols", "openai-chat.ts"),
  "utf8",
)
const session = readFileSync(join(import.meta.dir, "..", "..", "src", "session", "session.ts"), "utf8")

describe("gateway cost", () => {
  it("declares the redrob block, so parsing keeps it", () => {
    // Link 1. Without a declared field the schema silently discards it.
    expect(protocol).toContain("const RedrobGatewayBlock = Schema.Struct({")
    expect(protocol).toContain("costUsd: Schema.optional(Schema.Number)")
    expect(protocol).toContain("redrob: optionalNull(RedrobGatewayBlock)")
  })

  it("threads the block in from the event, not off the usage object", () => {
    // It is a SIBLING of `usage` on the wire, so `mapUsage` cannot find it on its own argument.
    expect(protocol).toContain("mapUsage(event.usage, event.redrob ?? undefined)")
  })

  it("forwards the block onto the event, which is what getUsage reads", () => {
    // Link 2, and the one that made the first fix a no-op.
    expect(protocol).toContain('state.usage?.providerMetadata?.["redrob"]')
    expect(protocol).toContain("providerMetadata: { redrob: gateway }")
  })

  it("forwards ONLY the gateway block", () => {
    /*
      Forwarding the whole usage metadata was the first attempt and put `{ openai: ... }` on the event for
      every OpenAI-compatible provider. A test caught it as a behaviour change nobody asked for, so the
      narrow form is pinned: no other provider's events may change shape.
    */
    expect(protocol).not.toContain("providerMetadata: state.usage?.providerMetadata")
  })

  it("is preferred over the local estimate, and validated before it is trusted", () => {
    expect(session).toContain('input.metadata?.["redrob"]?.["costUsd"]')
    expect(session).toContain(
      'typeof gatewayCostUsd === "number" && Number.isFinite(gatewayCostUsd) && gatewayCostUsd >= 0',
    )
    expect(session).toContain("return { cost: gatewayCostUsd, tokens }")
  })
})
