import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const src = (relative: string) => readFileSync(join(import.meta.dir, "..", "..", "src", relative), "utf8")

/**
 * Where compaction fires, and whose cost figure wins.
 *
 * Source assertions: both are decisions expressed as small pieces of arithmetic inside Effect services,
 * and the behavioural halves are covered by the compaction suite. What is pinned here is that neither
 * decision can be reverted quietly, because both were reverted-by-accident once already - the compaction
 * default by a test that asserted it, and the cost by nobody ever having wired the gateway's own number.
 */
describe("compaction threshold", () => {
  const source = src("session/overflow.ts")

  it("is a percentage of the window, defaulting to 70", () => {
    /*
      A 20,000-token reserve is most of a small window and 2% of a 1,000,000-token one, which put the
      trigger at 98% - late enough that the turn crossing it is also the turn that fails. A percentage
      scales with the model.
    */
    expect(source).toContain("DEFAULT_COMPACTION_THRESHOLD_PERCENT = 70")
    expect(source).toContain("input.cfg.compaction?.threshold ??")
  })

  it("clamps a nonsense value rather than trusting it", () => {
    // 0 would mean "compact before the first turn"; 500 would mean "never".
    expect(source).toContain("Math.min(100, Math.max(1, percent))")
  })

  it("still lets an explicit token reserve win", () => {
    // `reserved` is older and more specific: a caller who set a token budget meant that number.
    expect(source).toContain("input.cfg.compaction?.reserved !== undefined")
  })

  it("keeps room for the reply, whatever the threshold", () => {
    // A threshold of 100 must not mean "compact once the window is full", which is the failure the
    // reserve existed to avoid.
    expect(source).toContain("budget - Math.min(COMPACTION_BUFFER, output)")
  })

  it("treats a published input cap of 0 as absent, not as a cap of zero", () => {
    /*
      This one shipped broken for one CI round and is the reason the guard exists.

      `limit.input` is 0 for a model that publishes no separate input cap. Written as `limit.input ??
      context` that 0 SURVIVES - `0 ?? x` is 0 - so `usable()` returned 0, every session overflowed on its
      first turn, and a non-interactive run summarised in a loop until the harness killed it at 30s. Only
      one Windows shard happened to cover a model shaped that way, so it read as a flaky platform timeout
      rather than as the logic error it was. The original code used the truthy form for exactly this reason.
    */
    expect(source).toContain("input.model.limit.input || context")
    expect(source).not.toContain("input.model.limit.input ?? context")
  })

  it("is declared in the config schema, so it is settable and documented", () => {
    const schema = readFileSync(
      join(import.meta.dir, "..", "..", "..", "core", "src", "v1", "config", "config.ts"),
      "utf8",
    )
    expect(schema).toContain("threshold: Schema.optional(NonNegativeInt)")
  })
})

describe("cost", () => {
  const source = src("session/session.ts")

  it("prefers the gateway's own billed figure over the local estimate", () => {
    /*
      The console returns `costUsd` - the amount the account was debited. The local arithmetic cannot
      reproduce it: `auto` is billed at the ROUTED model's rate rather than the router's published one,
      the long-context rate applies past the short-context boundary, and the priority tier is 1.75x.
    */
    expect(source).toContain('input.metadata?.["redrob"]?.["costUsd"]')
    expect(source).toContain("return { cost: gatewayCostUsd, tokens }")
  })

  it("ignores a malformed figure instead of zeroing the cost", () => {
    // A missing or non-numeric field must fall through to the estimate, not report free.
    expect(source).toContain(
      'typeof gatewayCostUsd === "number" && Number.isFinite(gatewayCostUsd) && gatewayCostUsd >= 0',
    )
  })

  it("leaves Copilot's own override in place", () => {
    expect(source).toContain('input.metadata?.["copilot"]?.["totalNanoAiu"]')
  })
})
