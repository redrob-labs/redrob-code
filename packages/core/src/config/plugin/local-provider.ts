/**
 * Which endpoints a config file is allowed to introduce a provider for.
 *
 * `config/plugin/provider.ts` refuses to let local config introduce a new AI-SDK provider at all,
 * because an arbitrary npm `package` reaches DynamicProviderPlugin and gets installed and imported --
 * arbitrary code execution from a config file. That restriction is correct and stays.
 *
 * It also blocked the one case it did not need to: a LOCAL model runtime. Ollama, LM Studio, llama.cpp
 * and vLLM all speak the OpenAI-compatible wire protocol, which means they need no new package at all --
 * `@ai-sdk/openai-compatible` is already the trusted, pinned package the console provider itself uses. So
 * a local provider can be allowed without widening the package rule by one millimetre.
 *
 * Two conditions, and both are necessary:
 *
 *   1. The package is EXACTLY the already-trusted one. Anything else keeps the old refusal, so the
 *      install-an-arbitrary-package path stays shut.
 *   2. The URL is on this machine or this network. Without this, opening the door for local runtimes
 *      would also open a way for a config file to point a brand-new provider at any remote host --
 *      quietly routing prompts, and whatever is in them, somewhere the user never chose.
 *
 * This module is deliberately dependency-free so its test runs against the source with no build step.
 */

/** The one package a config file may introduce a provider with. Nothing else is accepted. */
export const LOCAL_PROVIDER_PACKAGE = "@ai-sdk/openai-compatible"

/**
 * Hostnames that always mean "this machine", independent of DNS.
 *
 * `localhost` is included even though it is resolved rather than parsed: refusing it would reject the
 * spelling almost every local runtime prints in its own startup banner, and it cannot be pointed
 * elsewhere without an attacker already being able to edit the host's name resolution -- at which point
 * they can edit the config file too.
 */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "::"])

/** `.localhost` is reserved for the local machine by RFC 6761, so a subdomain of it is still local. */
const LOCAL_SUFFIXES = [".localhost"]

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".")
  if (parts.length !== 4) return false
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  const [a, b] = octets
  // RFC 1918 private ranges, plus loopback and RFC 3927 link-local.
  if (a === 127) return true
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  return false
}

function isPrivateIPv6(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase()
  if (bare === "::1" || bare === "::") return true
  // fc00::/7 unique-local and fe80::/10 link-local.
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true
  return false
}

/**
 * Whether this URL is somewhere on the user's own machine or network.
 *
 * A URL that cannot be parsed is NOT local. That direction matters: the failure mode of guessing wrong
 * is allowing a config file to introduce a provider pointed at the open internet, so anything
 * unrecognised is refused rather than waved through.
 */
export function isLocalEndpoint(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  /*
    Only plain HTTP and HTTPS. A `file:` or other scheme reaching an HTTP client is not a local model
    runtime, and there is no reason to widen the set to find out what it is.
  */
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false

  const host = parsed.hostname.toLowerCase()
  if (LOCAL_HOSTNAMES.has(host)) return true
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  if (isPrivateIPv4(host)) return true
  if (isPrivateIPv6(host)) return true
  return false
}

/**
 * Whether config may introduce a NEW provider for this api block.
 *
 * Called only on the introduce path -- refining an existing provider is governed by the package rule
 * that was already there, and is unchanged.
 */
export function mayIntroduceLocalProvider(api: {
  readonly type: string
  readonly package?: string
  readonly url?: string
}): boolean {
  if (api.type !== "aisdk") return false
  if (api.package !== LOCAL_PROVIDER_PACKAGE) return false
  if (typeof api.url !== "string" || api.url.length === 0) return false
  return isLocalEndpoint(api.url)
}

/** Why an introduce attempt was refused, for a log line the user can act on. */
export function localProviderRefusal(api: { readonly type?: string; readonly package?: string; readonly url?: string }): string {
  if (api.type !== "aisdk") {
    return `a config file may only introduce a provider with api.type "aisdk", not ${JSON.stringify(api.type)}`
  }
  if (api.package !== LOCAL_PROVIDER_PACKAGE) {
    return `a config file may only introduce a provider using ${LOCAL_PROVIDER_PACKAGE}, not ${JSON.stringify(api.package)} -- any other package would be installed and imported from the config file`
  }
  if (typeof api.url !== "string" || api.url.length === 0) {
    return `a config file introducing a provider must give api.url, and it must be a local or private address`
  }
  return `${JSON.stringify(api.url)} is not a local or private address -- a config file may only introduce a provider for a runtime on this machine or this network`
}
