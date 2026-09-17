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

  /*
   * The routing half of the same block.
   *
   * `costUsd` was not the only field on it. `routedModel` and `upstreamProvider` answer "which model
   * actually produced this message", which `modelID` cannot: that field is what was REQUESTED, and
   * against this router the request is the literal `auto`. The protocol declared them from the start, so
   * they arrived and were then dropped one layer higher up - `getUsage` read only the cost, and the
   * message schemas did not name them, which drops a field just as silently as the protocol would.
   *
   * Pinned as a chain for the same reason the cost is: three separate links, each one sufficient on its
   * own to lose the value, and the failure is invisible at every one of them.
   */
  it("keeps the routing fields on the parsed block", () => {
    expect(protocol).toContain("routedModel: Schema.optional(Schema.String)")
    expect(protocol).toContain("upstreamProvider: Schema.optional(Schema.String)")
  })

  it("reads the routing fields where the cost is read, off the same block", () => {
    expect(session).toContain('input.metadata?.["redrob"]?.["routedModel"]')
    expect(session).toContain('input.metadata?.["redrob"]?.["upstreamProvider"]')
    // Strings only, so a malformed field cannot reach the message schema and fail an otherwise fine message.
    expect(session).toContain('typeof routedModelRaw === "string"')
  })

  it("names them on the message the app actually receives", () => {
    // The v1 Assistant is what the served API returns; naming it in one schema and not the other loses it.
    const v1 = readFileSync(
      join(import.meta.dir, "..", "..", "..", "schema", "src", "v1", "session.ts"),
      "utf8",
    )
    expect(v1).toContain("routedModel: Schema.optional(Schema.String)")
    expect(v1).toContain("upstreamProvider: Schema.optional(Schema.String)")
    const processor = readFileSync(join(import.meta.dir, "..", "..", "src", "session", "processor.ts"), "utf8")
    expect(processor).toContain("if (usage.routedModel) ctx.assistantMessage.routedModel = usage.routedModel")
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
    // The routing fields ride along on the same return; the cost preference itself is unchanged.
    expect(session).toContain("return { cost: gatewayCostUsd, tokens, ...routing }")
  })
})
