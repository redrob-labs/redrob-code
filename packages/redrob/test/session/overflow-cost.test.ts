import { describe, expect, it } from "bun:test"
import { isOverflow, usable } from "../../src/session/overflow"

/**
 * Where compaction fires, in money as well as in tokens.
 *
 * The percentage threshold was introduced because a fixed 20,000-token reserve is 2% of a 1,000,000-token
 * window, which put the trigger at 98% and made the turn that crossed it the turn that failed. It fixed
 * that and created the opposite problem, which a real session then demonstrated: 70% of a 1,000,000-token
 * window is 686,000 tokens, so at $3.15 per million input tokens the conversation is allowed to reach
 * about $2.16 of input on every later turn. The measured session sat at 384,023 tokens billed at $1.209861
 * per turn, with the token threshold still 300,000 tokens away and nothing due to happen.
 *
 * So both limits apply and the cheaper one wins. These pin that, and pin the cases where the cost limit
 * must NOT take over: an explicit `reserved`, a model with no published price, and an operator who set the
 * budget to zero.
 */
const model = (over: Partial<{ context: number; input: number; over200KInput: number }> = {}) =>
  ({
    limit: { context: over.context ?? 1_000_000, input: 0, output: 32_000 },
    cost:
      over.input === undefined
        ? undefined
        : {
            input: over.input,
            output: over.input * 5,
            cache: { read: 0, write: 0 },
            ...(over.over200KInput === undefined
              ? {}
              : {
                  experimentalOver200K: {
                    input: over.over200KInput,
                    output: over.over200KInput * 5,
                    cache: { read: 0, write: 0 },
                  },
                }),
          },
  }) as never

const tokens = (input: number) => ({
  total: input,
  input,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
})

describe("the cost ceiling", () => {
  it("fires far earlier than the percentage on a large window", () => {
    const cfg = {} as never
    const priced = usable({ cfg, model: model({ input: 3.15 }) })
    // $0.50 at $3.15 per million is about 158,000 tokens, against 686,000 for the percentage.
    expect(priced).toBeLessThan(200_000)
    expect(priced).toBeGreaterThan(100_000)
  })

  it("would have caught the session that was billed $1.21 a turn", () => {
    const cfg = {} as never
    expect(isOverflow({ cfg, tokens: tokens(384_023), model: model({ input: 3.15 }) })).toBe(true)
  })

  it("leaves a small window governed by the percentage, where it always was", () => {
    const cfg = {} as never
    // 70% of a 128,000-token window is under the token count $0.50 buys at a cheap rate, so nothing changes.
    const small = usable({ cfg, model: model({ context: 128_000, input: 0.15 }) })
    expect(small).toBe(usable({ cfg, model: model({ context: 128_000 }) }))
  })

  it("prices the ceiling at the long-context rate once past that tier", () => {
    /*
      Pricing it at the cheap rate would put the trigger past the point where the expensive rate has
      already started being paid, which is the moment the limit exists to catch.
    */
    const cfg = {} as never
    const long = usable({
      cfg,
      model: model({ input: 3.15, over200KInput: 6.3 }),
      tokens: 250_000,
    })
    const short = usable({ cfg, model: model({ input: 3.15, over200KInput: 6.3 }), tokens: 10_000 })
    expect(long).toBeLessThan(short)
  })

  it("does not apply to a model with no published price", () => {
    const cfg = {} as never
    expect(usable({ cfg, model: model() })).toBe(686_000)
  })

  it("is disabled by a zero budget", () => {
    const cfg = { compaction: { maxTurnInputCostUsd: 0 } } as never
    expect(usable({ cfg, model: model({ input: 3.15 }) })).toBe(686_000)
  })

  it("never overrides an explicit reserved budget", () => {
    // A caller who named a token count meant it; tightening it to a price they did not name is overreach.
    const cfg = { compaction: { reserved: 20_000 } } as never
    expect(usable({ cfg, model: model({ input: 3.15 }) })).toBe(980_000)
  })

  it("still respects compaction being turned off", () => {
    const cfg = { compaction: { auto: false } } as never
    expect(isOverflow({ cfg, tokens: tokens(900_000), model: model({ input: 3.15 }) })).toBe(false)
  })
})
