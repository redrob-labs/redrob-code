/**
 * PA-8's fit judgement.
 *
 * Every case here is a claim the user could push back on, so each asserts the NUMBERS in the
 * refusal rather than that a refusal happened. A verdict with no numbers is unfalsifiable by
 * the person it is about, which is the opposite of honest.
 */
import { describe, expect, test } from "bun:test"
import { LocalModelFit } from "@redrob-code/core/config/plugin/local-model-fit"

const GiB = 1024 ** 3

const machine = (overrides: Partial<LocalModelFit.Hardware> = {}): LocalModelFit.Hardware => ({
  platform: "linux",
  arch: "x64",
  cores: 8,
  totalBytes: 16 * GiB,
  availableBytes: 12 * GiB,
  ...overrides,
})

describe("LocalModelFit.requirementFor", () => {
  test("adds proportional headroom above the floor", () => {
    // 10 GiB of weights: 20% is 2 GiB, which clears the 1 GiB floor, so the floor does not apply.
    expect(LocalModelFit.requirementFor(10 * GiB)).toBe(12 * GiB)
  })

  test("applies the floor when the proportion is smaller than it", () => {
    // 2 GiB of weights: 20% is 0.4 GiB, under the floor, so the floor is what is added.
    expect(LocalModelFit.requirementFor(2 * GiB)).toBe(3 * GiB)
  })

  test("the headroom is never zero, so a model is never sized at exactly its weights", () => {
    expect(LocalModelFit.requirementFor(0)).toBe(LocalModelFit.HEADROOM_FLOOR_BYTES)
  })
})

describe("LocalModelFit.fit", () => {
  test("fits when available memory covers weights plus headroom", () => {
    const verdict = LocalModelFit.fit({ modelBytes: 4 * GiB, hardware: machine() })
    expect(verdict.kind).toBe("fits")
  })

  test("is short by the exact difference, and says closing something would do it", () => {
    // Needs 12 GiB (10 + 2 headroom); 8 free of 16 total, so freeing 4 GiB is enough.
    const verdict = LocalModelFit.fit({
      modelBytes: 10 * GiB,
      hardware: machine({ availableBytes: 8 * GiB, totalBytes: 16 * GiB }),
    })
    if (verdict.kind !== "short") throw new Error("expected a refusal")
    expect(verdict.constraint).toBe("memory")
    expect(verdict.requiredBytes).toBe(12 * GiB)
    expect(verdict.shortfallBytes).toBe(4 * GiB)
    expect(verdict.reason).toContain("12.0 GiB")
    expect(verdict.reason).toContain("8.0 GiB is free of 16.0 GiB total")
    expect(verdict.reason).toContain("if you close something")
  })

  test("says the machine is too small when freeing everything would not do it", () => {
    // Needs 12 GiB and the machine HAS 8 GiB. No amount of closing windows fixes this, and
    // telling the user to try would waste their time.
    const verdict = LocalModelFit.fit({
      modelBytes: 10 * GiB,
      hardware: machine({ availableBytes: 6 * GiB, totalBytes: 8 * GiB }),
    })
    if (verdict.kind !== "short") throw new Error("expected a refusal")
    expect(verdict.reason).toContain("more than this machine has in total")
    expect(verdict.reason).not.toContain("if you close something")
  })

  test("checks available rather than total, so a busy large machine is refused", () => {
    // 64 GiB machine with 2 GiB free. Checking total would promise a model that gets killed
    // partway through generating, which loses the user's work and explains nothing.
    const verdict = LocalModelFit.fit({
      modelBytes: 10 * GiB,
      hardware: machine({ availableBytes: 2 * GiB, totalBytes: 64 * GiB }),
    })
    expect(verdict.kind).toBe("short")
  })

  test("refuses an unsupported CPU before talking about memory at all", () => {
    // A machine with plenty of memory and no runtime build. Reporting a memory shortfall
    // here would send the user to close applications for a problem that is not memory.
    const verdict = LocalModelFit.fit({
      modelBytes: 1 * GiB,
      hardware: machine({ arch: "ppc64", availableBytes: 60 * GiB, totalBytes: 64 * GiB }),
    })
    if (verdict.kind !== "short") throw new Error("expected a refusal")
    expect(verdict.constraint).toBe("arch")
    expect(verdict.reason).toContain("ppc64")
  })

  test("an unseen GPU is reported as unmeasured, never as absent", () => {
    const verdict = LocalModelFit.fit({ modelBytes: 1 * GiB, hardware: machine({ gpu: undefined }) })
    expect(verdict.hardware.gpu).toBeUndefined()
    // The refusal text must never make a claim about a GPU we did not look at.
    const refused = LocalModelFit.fit({
      modelBytes: 100 * GiB,
      hardware: machine({ gpu: undefined }),
    })
    if (refused.kind !== "short") throw new Error("expected a refusal")
    expect(refused.reason.toLowerCase()).not.toContain("gpu")
    expect(refused.reason.toLowerCase()).not.toContain("graphics")
  })

  test("carries a measured GPU through untouched", () => {
    const gpu = { name: "Test GPU", vramBytes: 8 * GiB }
    const verdict = LocalModelFit.fit({ modelBytes: 1 * GiB, hardware: machine({ gpu }) })
    expect(verdict.hardware.gpu).toEqual(gpu)
  })
})

describe("LocalModelFit.measure", () => {
  test("reports this machine's real numbers, and no GPU claim without a probe", () => {
    const hardware = LocalModelFit.measure()
    expect(hardware.totalBytes).toBeGreaterThan(0)
    expect(hardware.availableBytes).toBeGreaterThan(0)
    expect(hardware.availableBytes).toBeLessThanOrEqual(hardware.totalBytes)
    expect(hardware.cores).toBeGreaterThan(0)
    expect(hardware.gpu).toBeUndefined()
  })

  test("takes the GPU from its caller rather than probing inside the verdict path", () => {
    // The split exists so the pure judgement is testable with no machine. If `measure` ever
    // probed on its own, this test would see a GPU it never passed in.
    const hardware = LocalModelFit.measure({ name: "Passed In" })
    expect(hardware.gpu?.name).toBe("Passed In")
  })
})
