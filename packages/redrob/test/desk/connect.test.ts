import { describe, expect, test } from "bun:test"
import { connect, GoneError, isToken, type DeskLocal, type Step } from "../../src/desk/connect"

const machine = { id: "m1", name: "build-01", os: "linux", arch: "x64" }

function local(over: Partial<{ signedInAfter: number; pending: string }> = {}) {
  let polls = 0
  let enabled = false
  const approved: string[] = []
  const desk: DeskLocal = {
    status: async () => {
      polls++
      const signedIn = polls > (over.signedInAfter ?? 2)
      return {
        enabled,
        signedIn,
        ...(signedIn ? { account: { email: "a@b.c" } } : { login: { userCode: "ABCD-EFGH", verificationUriComplete: "https://devauth.redrob.io/device?user_code=ABCD-EFGH", expiresAt: Date.now() + 600_000 } }),
        pending: over.pending ? [{ code: over.pending, name: "Chrome", kind: "web" as const, expiresAt: 0 }] : [],
      }
    },
    login: async () => ({ userCode: "ABCD-EFGH", verificationUriComplete: "https://x/device", expiresAt: Date.now() + 600_000 }),
    enable: async () => {
      enabled = true
    },
    approve: async (code) => {
      approved.push(code)
      return { id: "dev_1", name: "Chrome" }
    },
  }
  return { desk, approved }
}

describe("desk connect", () => {
  test("token format", () => {
    expect(isToken("rc_7Kq2abcdEFGH")).toBe(true)
    expect(isToken("rc_short")).toBe(false)
    expect(isToken("rc_;rm -rf")).toBe(false)
    expect(isToken("xx_7Kq2abcdEFGH")).toBe(false)
  })

  test("signs in, turns the desk on and approves the card's browser", async () => {
    const steps: Step[] = []
    let polls = 0
    const { desk, approved } = local({ pending: "123456" })
    const device = await connect(
      {
        report: async (step) => void steps.push(step),
        poll: async () => (++polls > 1 ? { pairCode: "123456" } : {}),
      },
      desk,
      { machine, say: () => undefined, sleep: async () => undefined },
    )
    expect(device).toEqual({ id: "dev_1", name: "Chrome" })
    expect(approved).toEqual(["123456"])
    expect(steps.map((step) => step.step)).toEqual(["login", "signed_in", "paired"])
    expect(steps[0]).toMatchObject({ userCode: "ABCD-EFGH", verificationUri: "https://devauth.redrob.io/device?user_code=ABCD-EFGH" })
    expect(steps[1]).toMatchObject({ email: "a@b.c", machine })
  })

  test("approves nothing but the code the card sent", async () => {
    const { desk, approved } = local({ signedInAfter: 0, pending: "999999" })
    let now = 0
    await expect(
      connect(
        { report: async () => undefined, poll: async () => ({ pairCode: "123456" }) },
        desk,
        { machine, say: () => undefined, now: () => now, sleep: async () => void (now += 60_000) },
      ),
    ).rejects.toThrow("did not connect in time")
    expect(approved).toEqual([])
  })

  test("a used or expired code stops at once", async () => {
    const { desk } = local()
    const steps: string[] = []
    await expect(
      connect(
        {
          report: async (step) => {
            steps.push(step.step)
            throw new GoneError("this connect code is used or expired")
          },
          poll: async () => ({}),
        },
        desk,
        { machine, say: () => undefined, sleep: async () => undefined },
      ),
    ).rejects.toThrow("used or expired")
    expect(steps).toEqual(["login"])
  })
})
