import { describe, expect, test } from "bun:test"
import { Mask } from "@redrob-code/core/privacy/mask"

describe("privacy mask", () => {
  test("regex tier finds email, phone, card and resident number; placeholders are stable", () => {
    const vault = new Mask.Vault()
    const text = "Mail hong@example.com or call 010-1234-5678. Card 4242 4242 4242 4242, RRN 900101-1234567. Order 12345678901234."
    const masked = vault.maskText(text)
    expect(masked).toBe("Mail [EMAIL_1] or call [PHONE_1]. Card [CARD_1], RRN [RRN_1]. Order 12345678901234.")
    expect(vault.maskText("hong@example.com again")).toBe("[EMAIL_1] again")
    expect(vault.unmask(masked)).toBe(text)
  })

  test("a request leaves with placeholders in user text and tool results, system prompt untouched", () => {
    const vault = new Mask.Vault()
    const request = {
      model: {} as never,
      system: [{ type: "text" as const, text: "You help hong@example.com" }],
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: "write to hong@example.com" }] },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              id: "t1",
              name: "read",
              result: { type: "text" as const, value: "contact: hong@example.com" },
            },
          ],
        },
      ],
      tools: [],
    }
    const masked = Mask.maskRequest(vault, request as never)
    expect(JSON.stringify(masked.messages)).not.toContain("hong@example.com")
    expect(JSON.stringify(masked.messages)).toContain("[EMAIL_1]")
    expect(masked.system[0]!.text).toContain("hong@example.com")
  })

  test("streamed answer is restored even when a placeholder splits across deltas; tool inputs are restored whole", () => {
    const vault = new Mask.Vault()
    vault.add({ value: "Hong Gildong", kind: "PERSON" })
    const unmask = Mask.unmaskEvents(vault)
    const out: string[] = []
    for (const chunk of ["Dear [PER", "SON_", "1], hello [PERSON_1]", " and [PERSON_2]"]) {
      for (const event of unmask({ type: "text-delta", id: "b", text: chunk } as never))
        if (event.type === "text-delta") out.push(event.text)
    }
    for (const event of unmask({ type: "text-end", id: "b" } as never)) if (event.type === "text-delta") out.push(event.text)
    expect(out.join("")).toBe("Dear Hong Gildong, hello Hong Gildong and [PERSON_2]")

    const [call] = unmask({ type: "tool-call", id: "c", name: "write", input: { path: "[PERSON_1].md", lines: ["[PERSON_1]"] } } as never)
    expect((call as { input: unknown }).input).toEqual({ path: "Hong Gildong.md", lines: ["Hong Gildong"] })
  })

  test("model answer is parsed strictly; garbage is ignored", () => {
    expect(Mask.parseEntities('Sure! {"PERSON":["Hong Gildong"],"ORG":["Redrob"],"LOC":[]} done')).toEqual([
      { value: "Hong Gildong", kind: "PERSON" },
      { value: "Redrob", kind: "ORG" },
    ])
    expect(Mask.parseEntities("no json here")).toEqual([])
    expect(Mask.parseEntities('{"PERSON": 42}')).toEqual([])
  })

  test("settings default to off and the last document wins", () => {
    expect(Mask.settings([]).mode).toBe("off")
    expect(
      Mask.settings([
        { info: { privacy: { mask_pii: "model", model: "ollama/qwen" } } },
        { info: { privacy: { mask_pii: "regex" } } },
      ]),
    ).toEqual({ mode: "regex", model: "ollama/qwen" })
  })
})
