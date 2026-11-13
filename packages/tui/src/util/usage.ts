import { Locale } from "./locale"

/**
 * What `/status` shows under Usage. The figures are the engine's own step-finish cost and tokens --
 * the same numbers the prompt footer's `$7.92` comes from -- so nothing here re-prices anything.
 */
export type Tokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type Total = {
  cost: number
  tokens: Tokens
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

/** Epoch ms where today and this month start, in the user's local time zone. */
export function bounds(now = new Date()) {
  return {
    day: new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(),
    month: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
  }
}

/** Reasoning is billed as output, and cache reads and writes are one cache figure. */
export function format(total: Total) {
  return {
    input: Locale.number(total.tokens.input),
    output: Locale.number(total.tokens.output + total.tokens.reasoning),
    cache: Locale.number(total.tokens.cache.read + total.tokens.cache.write),
    cost: money.format(total.cost),
  }
}

/** The console's `/usage/summary` reply, as the engine passes it through. */
export type Console = {
  currency: string
  balance: number
  complimentary: boolean
  today: { spend: number; requestCount: number }
  month: { spend: number; requestCount: number }
}

/** Below this the balance is shown as a warning. */
export const LOW_BALANCE = 1

/** The Console block's figures, formatted in the workspace's own currency. */
export function workspace(value: Console) {
  const currency = (() => {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: value.currency })
    } catch {
      return money
    }
  })()
  const count = new Intl.NumberFormat("en-US")
  return {
    balance: currency.format(value.balance),
    low: !value.complimentary && value.balance < LOW_BALANCE,
    complimentary: value.complimentary,
    today: { spend: currency.format(value.today.spend), count: count.format(value.today.requestCount) },
    month: { spend: currency.format(value.month.spend), count: count.format(value.month.requestCount) },
  }
}

export * as Usage from "./usage"
