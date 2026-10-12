/**
 * Who competes and who judges.
 *
 * A build-off is only neutral if its builders come from different companies, and a review is only
 * fair if the reviewer's company built neither candidate. Both rules need to know the vendor behind a
 * model id, which the Console's ids encode in two shapes: curated bare ids (`claude-opus-5`,
 * `gpt-5.6-sol`) and OpenRouter slugs (`google/gemini-2.5-pro`, `qwen/qwen3-coder`).
 */

export type ModelRef = { providerID: string; id: string }
export type Candidate = ModelRef & { vendor: string; name?: string; tools: boolean }

const BARE_VENDORS: [RegExp, string][] = [
  [/^claude/i, "anthropic"],
  [/^(gpt|o\d|codex|chatgpt)/i, "openai"],
  [/^gemini|^gemma/i, "google"],
  [/^qwen/i, "qwen"],
  [/^deepseek/i, "deepseek"],
  [/^(kimi|moonshot)/i, "moonshotai"],
  [/^glm/i, "z-ai"],
  [/^grok/i, "x-ai"],
  [/^(mistral|codestral|devstral|magistral)/i, "mistralai"],
  [/^llama/i, "meta-llama"],
  [/^minimax/i, "minimax"],
]

/** Slug prefixes that are the same company under two names. */
const ALIASES: Record<string, string> = { "z-ai": "z-ai", zhipu: "z-ai", moonshot: "moonshotai", meta: "meta-llama" }

export function vendorOf(model: ModelRef): string {
  const slash = model.id.indexOf("/")
  if (slash > 0) {
    const prefix = model.id.slice(0, slash).toLowerCase()
    return ALIASES[prefix] ?? prefix
  }
  for (const [pattern, vendor] of BARE_VENDORS) if (pattern.test(model.id)) return vendor
  // A provider other than the Console (a person's own key, a local runtime) is its own vendor.
  return model.providerID === "redrob" ? model.id.toLowerCase() : model.providerID.toLowerCase()
}

/**
 * Ids that are never a builder or a reviewer.
 *
 * `auto` is a router, not a model: two `auto` slots could be the same model, which defeats the point.
 * `claude-fable-*` requires `provider_data_share`, which conflicts with not training on customer code.
 * The free tier is a taster, not a contestant.
 */
export function eligible(model: ModelRef & { tools?: boolean }) {
  if (model.tools === false) return false
  const id = model.id.toLowerCase()
  if (id === "auto" || id.endsWith("/auto")) return false
  if (id.includes("claude-fable")) return false
  if (id === "free" || id.endsWith("/free")) return false
  if (/(embed|tts|whisper|transcribe|image|audio|moderation)/.test(id)) return false
  return true
}

export type BenchOptions = {
  builders: number
  /** Explicit `provider/model` picks; any not available are reported, not silently replaced. */
  prefer?: string[]
  /** Vendors in the order to try, for the slots `prefer` does not fill. */
  vendorOrder?: string[]
  /** Reviewers to choose, from vendors not already building where possible. */
  reviewers: number
  /** Replaces Math.random for the slot shuffle, so tests can pin it. */
  random?: () => number
}

export type Bench = {
  builders: Candidate[]
  reviewers: Candidate[]
  /** False when there were not enough distinct vendors to keep every builder from a different one. */
  neutral: boolean
  notes: string[]
}

export const DEFAULT_VENDOR_ORDER = [
  "anthropic",
  "openai",
  "google",
  "qwen",
  "deepseek",
  "moonshotai",
  "z-ai",
  "x-ai",
  "mistralai",
]

export const key = (model: ModelRef) => `${model.providerID}/${model.id}`

export function parseModel(value: string): ModelRef {
  const slash = value.indexOf("/")
  if (slash <= 0) return { providerID: "redrob", id: value }
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
}

export function chooseBench(available: Candidate[], options: BenchOptions): Bench {
  const notes: string[] = []
  const pool = available.filter(eligible)
  const order = options.vendorOrder ?? DEFAULT_VENDOR_ORDER
  const builders: Candidate[] = []
  const used = new Set<string>()

  for (const wanted of options.prefer ?? []) {
    if (builders.length >= options.builders) break
    const ref = parseModel(wanted)
    const found = pool.find((model) => key(model) === key(ref)) ?? pool.find((model) => model.id === wanted)
    if (!found) {
      notes.push(`${wanted} is not available to this key`)
      continue
    }
    if (!builders.some((model) => key(model) === key(found))) builders.push(found)
  }
  for (const model of builders) used.add(model.vendor)

  const byVendor = new Map<string, Candidate[]>()
  for (const model of pool) byVendor.set(model.vendor, [...(byVendor.get(model.vendor) ?? []), model])
  const vendors = [...new Set([...order.filter((vendor) => byVendor.has(vendor)), ...byVendor.keys()])]

  for (const vendor of vendors) {
    if (builders.length >= options.builders) break
    if (used.has(vendor)) continue
    builders.push(byVendor.get(vendor)![0]!)
    used.add(vendor)
  }

  let neutral = true
  if (builders.length < options.builders) {
    // Not enough companies: fill from vendors already in, and say so rather than pretend.
    for (const model of pool) {
      if (builders.length >= options.builders) break
      if (!builders.some((existing) => key(existing) === key(model))) {
        builders.push(model)
        neutral = false
      }
    }
    if (!neutral) notes.push("fewer distinct vendors than builders; some builders share a company")
  }
  if (new Set(builders.map((model) => model.vendor)).size < builders.length) neutral = false

  const reviewerPool = [
    ...pool.filter((model) => !used.has(model.vendor)),
    ...pool.filter((model) => used.has(model.vendor) && !builders.some((b) => key(b) === key(model))),
    ...builders,
  ]
  const reviewers: Candidate[] = []
  const reviewerVendors = new Set<string>()
  for (const model of reviewerPool) {
    if (reviewers.length >= options.reviewers) break
    if (reviewerVendors.has(model.vendor)) continue
    reviewers.push(model)
    reviewerVendors.add(model.vendor)
  }
  if (reviewers.some((model) => used.has(model.vendor)))
    notes.push(
      "not enough outside vendors to review; a reviewer shares a company with a builder and sits out those pairs",
    )

  return { builders: shuffle(builders, options.random ?? Math.random), reviewers, neutral, notes }
}

function shuffle<T>(items: T[], random: () => number) {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
  }
  return copy
}

export const SLOT_NAMES = "ABCDEFGHIJ".split("")
