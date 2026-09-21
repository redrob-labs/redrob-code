import { describe, expect, test } from "bun:test"
import {
  LOCAL_PROVIDER_PACKAGE,
  isLocalEndpoint,
  localProviderRefusal,
  mayIntroduceLocalProvider,
} from "@redrob-code/core/config/plugin/local-provider"

/*
  This is a security boundary, so the REFUSALS are what matter most. A predicate that is too permissive
  lets a config file introduce a provider pointed anywhere on the internet; one that is too strict just
  fails to find Ollama, which the user notices immediately. The tests are weighted accordingly.
*/

describe("isLocalEndpoint", () => {
  test("accepts the spellings a local runtime actually prints", () => {
    for (const url of [
      "http://127.0.0.1:11434/v1",
      "http://localhost:11434/v1",
      "http://localhost:1234/v1",
      "http://[::1]:8080/v1",
      "http://0.0.0.0:8000/v1",
    ]) {
      expect(isLocalEndpoint(url)).toBe(true)
    }
  })

  test("accepts a runtime on another machine on the same private network", () => {
    // A workstation calling a GPU box on the LAN is the ordinary case, not an exotic one.
    for (const url of [
      "http://10.0.0.5:11434/v1",
      "http://192.168.1.40:8000/v1",
      "http://172.16.0.9:11434/v1",
      "http://172.31.255.254:11434/v1",
      "https://10.1.2.3/v1",
    ]) {
      expect(isLocalEndpoint(url)).toBe(true)
    }
  })

  test("refuses public addresses, which is the whole point of the check", () => {
    for (const url of [
      "https://api.openai.com/v1",
      "https://evil.example/v1",
      "http://8.8.8.8/v1",
      "http://172.32.0.1/v1", // just outside 172.16/12
      "http://172.15.255.255/v1", // just below it
      "http://11.0.0.1/v1", // just outside 10/8
      "http://192.169.1.1/v1", // just outside 192.168/16
    ]) {
      expect(isLocalEndpoint(url)).toBe(false)
    }
  })

  test("refuses a hostname that merely CONTAINS a local name", () => {
    // `localhost.evil.example` resolves wherever its owner wants; only a real suffix match is local.
    for (const url of [
      "http://localhost.evil.example/v1",
      "http://127.0.0.1.evil.example/v1",
      "http://notlocalhost/v1",
    ]) {
      expect(isLocalEndpoint(url)).toBe(false)
    }
  })

  test("accepts a subdomain of .localhost, which RFC 6761 reserves for this machine", () => {
    expect(isLocalEndpoint("http://ollama.localhost:11434/v1")).toBe(true)
  })

  test("refuses anything that is not http or https", () => {
    for (const url of ["file:///etc/passwd", "ftp://127.0.0.1/v1", "ws://127.0.0.1/v1"]) {
      expect(isLocalEndpoint(url)).toBe(false)
    }
  })

  test("an unparseable url is refused rather than guessed at", () => {
    // Failing closed matters: guessing wrong in the other direction allows a public endpoint.
    for (const url of ["", "not a url", "http://", "127.0.0.1:11434"]) {
      expect(isLocalEndpoint(url)).toBe(false)
    }
  })

  test("an out-of-range octet does not parse, so it is refused", () => {
    expect(isLocalEndpoint("http://10.0.0.999/v1")).toBe(false)
  })

  test("the short IPv4 form is judged by what it actually addresses", () => {
    /*
      The URL parser normalises `10.0.0` to `10.0.0.0` -- a real address, and a private one. My first
      version of this test asserted the opposite and failed, correctly: refusing it would refuse a host
      that genuinely is on a private network, while the whole predicate is about where the request lands.
      The public-side counterpart is what has to stay refused.
    */
    expect(isLocalEndpoint("http://10.0.0/v1")).toBe(true)
    expect(isLocalEndpoint("http://11.0.0/v1")).toBe(false)
  })
})

describe("mayIntroduceLocalProvider", () => {
  const local = { type: "aisdk", package: LOCAL_PROVIDER_PACKAGE, url: "http://127.0.0.1:11434/v1" }

  test("allows the trusted package at a local address", () => {
    expect(mayIntroduceLocalProvider(local)).toBe(true)
  })

  test("refuses any other package, even at a local address", () => {
    // This is the rule the original comment existed to enforce: an arbitrary package would be
    // installed and imported, which is arbitrary code execution from a config file.
    expect(mayIntroduceLocalProvider({ ...local, package: "@ai-sdk/openai" })).toBe(false)
    expect(mayIntroduceLocalProvider({ ...local, package: "totally-fine-package" })).toBe(false)
    expect(mayIntroduceLocalProvider({ ...local, package: undefined })).toBe(false)
  })

  test("refuses the trusted package at a public address", () => {
    expect(mayIntroduceLocalProvider({ ...local, url: "https://api.openai.com/v1" })).toBe(false)
  })

  test("refuses a native provider, which is not what config introduces", () => {
    expect(mayIntroduceLocalProvider({ type: "native", url: "http://127.0.0.1:11434/v1" })).toBe(false)
  })

  test("refuses a missing url instead of defaulting to somewhere", () => {
    expect(mayIntroduceLocalProvider({ type: "aisdk", package: LOCAL_PROVIDER_PACKAGE })).toBe(false)
  })
})

describe("localProviderRefusal", () => {
  test("names the package rule when the package is wrong", () => {
    const message = localProviderRefusal({ type: "aisdk", package: "@ai-sdk/openai", url: "http://127.0.0.1/v1" })
    expect(message).toContain(LOCAL_PROVIDER_PACKAGE)
    expect(message).toContain("installed and imported")
  })

  test("names the address rule when the address is wrong", () => {
    const message = localProviderRefusal({
      type: "aisdk",
      package: LOCAL_PROVIDER_PACKAGE,
      url: "https://api.openai.com/v1",
    })
    expect(message).toContain("local or private")
  })
})
