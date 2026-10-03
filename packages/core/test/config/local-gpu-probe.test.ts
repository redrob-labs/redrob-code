/**
 * PA-8's GPU parsers, against recorded tool output.
 *
 * Parsed, not mocked: each fixture is the shape the real command prints, with the flags the
 * probe passes. A parser verified only against a string I also wrote would prove the two
 * agree and nothing about the tool.
 *
 * The failure these guard is silent. A parser that returns `undefined` for output it should
 * have read makes the machine look like one with no GPU, which is a false claim this module
 * exists specifically to avoid.
 */
import { describe, expect, test } from "bun:test"
import { LocalGpuProbe } from "@redrob-code/core/config/plugin/local-gpu-probe"

const MiB = 1024 * 1024

const probeFor = (command: string) => {
  const found = LocalGpuProbe.PROBES.find((candidate) => candidate.command === command)
  if (found === undefined) throw new Error(`no probe spawns ${command}`)
  return found
}

describe("nvidia-smi", () => {
  const nvidia = probeFor("nvidia-smi")

  test("passes the flags that make the output machine-readable", () => {
    // `noheader,nounits` is what lets the parse be a comma split instead of a column guess,
    // and `nounits` is why the memory field is read as plain MiB.
    expect(nvidia.args.join(" ")).toContain("--format=csv,noheader,nounits")
    expect(nvidia.args.join(" ")).toContain("memory.total")
  })

  test("reads name and VRAM from one card", () => {
    expect(nvidia.parse("NVIDIA GeForce RTX 4090, 24564\n")).toEqual({
      name: "NVIDIA GeForce RTX 4090",
      vramBytes: 24564 * MiB,
    })
  })

  test("takes the first card when several are listed", () => {
    const output = "NVIDIA A100-SXM4-40GB, 40960\nNVIDIA A100-SXM4-40GB, 40960\n"
    expect(nvidia.parse(output)?.name).toBe("NVIDIA A100-SXM4-40GB")
  })

  test("keeps the name when the memory field is unreadable", () => {
    // A driver that reports `[N/A]` for memory still tells us the card exists, and a card we
    // know about with a size we do not is better than pretending there is no card.
    const parsed = nvidia.parse("NVIDIA GeForce GTX 1060, [N/A]\n")
    expect(parsed?.name).toBe("NVIDIA GeForce GTX 1060")
    expect(parsed?.vramBytes).toBeUndefined()
  })

  test("returns undefined for empty output rather than an empty name", () => {
    expect(nvidia.parse("")).toBeUndefined()
    expect(nvidia.parse("\n\n")).toBeUndefined()
  })
})

describe("apple silicon", () => {
  const sysctl = probeFor("sysctl")

  test("names the chip and reports no separate VRAM", () => {
    // Unified memory: the GPU uses the same bytes the memory check already counted, so a
    // VRAM number here would be those bytes counted twice.
    expect(sysctl.parse("Apple M3 Max\n")).toEqual({ name: "Apple M3 Max (unified memory)", vramBytes: undefined })
  })

  test("declines an Intel Mac rather than calling its CPU a GPU", () => {
    expect(sysctl.parse("Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz\n")).toBeUndefined()
  })

  test("is offered only on darwin", () => {
    expect(sysctl.platforms).toEqual(["darwin"])
  })
})

describe("probe ordering", () => {
  test("nvidia is tried before the platform-specific fallback on darwin", () => {
    // An external or eGPU NVIDIA card is the more specific answer, and the sysctl probe
    // would otherwise claim unified memory on a machine that has a discrete card.
    const darwin = LocalGpuProbe.PROBES.filter((candidate) => candidate.platforms.includes("darwin"))
    expect(darwin[0]?.command).toBe("nvidia-smi")
  })

  test("every probe declares the platforms it applies to", () => {
    for (const candidate of LocalGpuProbe.PROBES) expect(candidate.platforms.length).toBeGreaterThan(0)
  })
})
