import type { NamedError } from "@redrob-code/core/util/error"
import { SessionV1 } from "@redrob-code/core/v1/session"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"

export type Err = ReturnType<NamedError["toObject"]>

export const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go"
export const GO_UPSELL_URL = "https://code.redrob.ai/go"
/**
 * Where a console refusal sends the user. `/limits` shows the tier and its per-minute ceiling;
 * `/api-keys` is where a key's monthly cap is raised; `/billing` is where the account is topped up.
 * Each card links to the page that fixes ITS refusal, because a card that lands on the wrong page is
 * barely better than no card.
 */
export const CONSOLE_LIMITS_URL = "https://console.redrob.ai/limits"
export const CONSOLE_KEYS_URL = "https://console.redrob.ai/api-keys"
export const CONSOLE_BILLING_URL = "https://console.redrob.ai/billing"
export type RetryReason =
  | "free_tier_limit"
  | "account_rate_limit"
  | "console_rate_limit"
  | "console_key_budget"
  | "console_out_of_credit"
  | (string & {})

export type Retryable = {
  message: string
  action?: {
    reason: RetryReason
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_JITTER_FACTOR = 0.25
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
export const RETRY_MAX_RETRIES = 5

const RETRYABLE_MESSAGE_PATTERNS = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: SessionV1.APIError, random = Math.random()) {
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      return cap(exponential(attempt, random))
    }
  }

  return cap(Math.min(exponential(attempt, random), RETRY_MAX_DELAY_NO_HEADERS))
}

function exponential(attempt: number, random: number) {
  const base = RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
  return Math.ceil(base + base * RETRY_JITTER_FACTOR * random)
}

/**
 * A console refusal the user can act on, as the card cowork already draws.
 *
 * Only for our own provider. `rate_limit_exceeded` and `insufficient_quota` are OpenAI's generic codes,
 * so any vendor may send them -- offering a link to the Redrob console for somebody else's rate limit
 * would send the user to a page that cannot fix their problem.
 *
 * Only the RATE refusal is here. A 402 is deliberately not retryable: the console chose that status over
 * 429 precisely so clients would stop rather than turn one refusal into six, and a spinner reading
 * "Retrying in 4s" over something that will never succeed is worse than a plain message. Those are
 * handled by `blocking()` instead.
 */
function consoleRateLimit(error: SessionV1.APIError, provider: string): Retryable | undefined {
  if (provider !== "redrob") return undefined
  if (consoleErrorCode(error) !== "rate_limit_exceeded") return undefined

  /*
    The console's own message already names the tier's per-minute ceiling and how long to wait, so it is
    used as-is rather than paraphrased into something less specific.
  */
  const message = error.data.message || "Rate limit reached"
  return {
    message,
    action: {
      reason: "console_rate_limit",
      provider,
      title: "Rate limit reached",
      message:
        "This is your workspace's requests-per-minute ceiling, which rises with your lifetime top-ups. It clears on its own; the console shows the current tier and limit.",
      label: "open limits",
      link: CONSOLE_LIMITS_URL,
    },
  }
}

/** The machine-readable code from the console's OpenAI-shaped error envelope, if there is one. */
function consoleErrorCode(error: SessionV1.APIError): string | undefined {
  const body = parseJSON(error.data.responseBody)
  if (!isRecord(body)) return undefined
  const envelope = body["error"]
  if (!isRecord(envelope)) return undefined
  const code = envelope["code"]
  return typeof code === "string" && code.length > 0 ? code : undefined
}

export type Blocking = {
  message: string
  action?: Retryable["action"]
}

/**
 * A console refusal that retrying cannot fix, but a person can.
 *
 * Both of the console's 402s land here. They are NOT routed through `retryable()` on purpose: the console
 * answers 402 rather than 429 specifically so that clients stop, and a retry card would both retry and
 * claim to be retrying something that will never succeed.
 *
 * The two are told apart by `code`, which is the only thing that distinguishes them on the
 * OpenAI-compatible path -- the console's fuller refusal body, with `reason` and the figures, does not
 * survive that envelope. They need different pages: a key over its cap is fixed by raising that key's
 * cap, an empty balance by topping up, and sending the user to the wrong one wastes the card.
 */
export function blocking(error: Err, provider: string): Blocking | undefined {
  if (provider !== "redrob") return undefined
  if (!SessionV1.APIError.isInstance(error)) return undefined
  const code = consoleErrorCode(error)
  /* The console's own message carries the figures, so it is shown rather than paraphrased. */
  const message = error.data.message || "The request was refused"

  if (code === "api_key_budget_exhausted") {
    return {
      message,
      action: {
        reason: "console_key_budget",
        provider,
        title: "This key is over its monthly budget",
        message:
          "The cap is per API key and resets at the start of the month. Raise it on the key, or use a key without a cap.",
        label: "open api keys",
        link: CONSOLE_KEYS_URL,
      },
    }
  }

  if (code === "insufficient_quota") {
    return {
      message,
      action: {
        reason: "console_out_of_credit",
        provider,
        title: "The workspace is out of credit",
        message: "Top up to continue. A balance covers every key on the workspace.",
        label: "open billing",
        link: CONSOLE_BILLING_URL,
      },
    }
  }

  return undefined
}

export function retryable(error: Err, provider: string) {
  // context overflow errors should not be retried
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    const status = error.data.statusCode
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (
      !error.data.isRetryable &&
      !(status !== undefined && status >= 500) &&
      !matchesRetryableMessage(error.data.message) &&
      !matchesRetryableMessage(error.data.responseBody)
    )
      return undefined
    /*
      Checked before the upstream markers below, because those match on a body substring while this
      matches on the console's own error code -- the more specific signal should win.
    */
    const rate = consoleRateLimit(error, provider)
    if (rate) return rate
    if (error.data.responseBody?.includes("FreeUsageLimitError")) {
      return {
        message: GO_UPSELL_MESSAGE,
        action: {
          reason: "free_tier_limit",
          provider,
          title: "Free limit reached",
          message: "Subscribe to RedrobCode Go for reliable access to the best open-source models for $10/month.",
          label: "subscribe",
          link: GO_UPSELL_URL,
        },
      }
    }
    if (error.data.responseBody?.includes("GoUsageLimitError")) {
      const body = parseJSON(error.data.responseBody)
      const workspace = str(body?.metadata?.workspace)
      const limitName = str(body?.metadata?.limitName)
      const retryAfter = num(error.data.responseHeaders?.["retry-after"])
      const resetIn = iife(() => {
        if (retryAfter === undefined) return ""
        const seconds = Math.max(0, Math.ceil(retryAfter))
        const days = Math.floor(seconds / 86_400)
        const hours = Math.floor((seconds % 86_400) / 3_600)
        const minutes = Math.ceil((seconds % 3_600) / 60)
        const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`

        if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day")
        if (hours > 0) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour")
        return minutes > 0 ? unit(minutes, "minute") : "less than a minute"
      })

      const message = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached. It will reset in ${resetIn}. To continue using this model now, enable usage from your available balance`

      const link = `https://code.redrob.ai/workspace/${workspace}/go`
      return {
        message: `${message} - ${link}`,
        action: {
          reason: "account_rate_limit",
          provider,
          title: "Go limit reached",
          message,
          label: "open settings",
          link,
        },
      }
    }
    return { message: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message }
  }

  const message = isRecord(error.data) ? error.data.message : undefined
  if (typeof message !== "string") return undefined
  const lower = message.toLowerCase()
  if (lower.includes("too_many_requests")) return { message: "Too Many Requests" }
  if (lower.includes("exhausted") || lower.includes("unavailable")) return { message: "Provider is overloaded" }
  if (matchesRetryableMessage(message)) return { message }
  return undefined
}

function matchesRetryableMessage(value: unknown) {
  return typeof value === "string" && RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))
}

function str(value: unknown) {
  if (value === undefined || value === null) return ""
  return String(value)
}

function num(value: unknown) {
  const parsed = Number.parseFloat(str(value))
  if (Number.isNaN(parsed)) return undefined
  return parsed
}

function parseJSON(value: unknown) {
  return iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })
}

export function policy(opts: {
  provider: string
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const retry = retryable(error, opts.provider)
      if (!retry) return Cause.done(meta.attempt)
      if (meta.attempt > RETRY_MAX_RETRIES) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const wait = delay(meta.attempt, SessionV1.APIError.isInstance(error) ? error : undefined)
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({
          attempt: meta.attempt,
          message: retry.message,
          action: retry.action,
          next: now + wait,
        })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
