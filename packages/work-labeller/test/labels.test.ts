import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { externalIdOf, labelSession, SessionRecorder, sha256Hex, type LabeledSession, type LabelingApp } from "../src/index.js";

const OFFICE: LabelingApp = { toolKey: "office", idPrefix: "of_", labelerId: "office", labelerVersion: "1" };

describe("labels, for any app", () => {
  test("sha256Hex is SHA-256", () => {
    for (const text of ["", "abc", "세션-123", "x".repeat(55), "x".repeat(56), "x".repeat(64), "y".repeat(1000)]) {
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"));
    }
  });

  test("ids and labels carry the app's tool, prefix and labeler", () => {
    expect(externalIdOf(OFFICE, "chat-1")).toBe(`of_${createHash("sha256").update("chat-1").digest("hex").slice(0, 32)}`);
    const session = labelSession(OFFICE, {
      rootSessionID: "chat-1", startedAt: 0, lastActivityAt: 0, userTurns: 1, firstAttachedSource: false, assistantMessages: 1,
      toolCalls: 0, artifacts: 1, checks: 0, sends: 0, delegations: 0, peakConcurrentAgents: 0, subagentMinutes: 0, busyMinutes: 0,
      attentionMinutes: 0, permissionsAsked: 0, permissionsAlways: 0, aborted: 0, redirected: 0, sensitiveSends: 0, unmaskedSends: 0,
      action: "spec", family: "write",
    });
    expect(session).toMatchObject({ toolKey: "office", labelerId: "office", labelerVersion: "1", mode: 2, actionKey: "spec", familyKey: "write" });
  });

  test("the recorder labels a finished session under its app", async () => {
    const out: LabeledSession[] = [];
    const recorder = new SessionRecorder(OFFICE, (s) => void out.push(s), 1000);
    recorder.observe({ kind: "user-turn", sessionID: "chat-1", messageID: "m1", at: 0, attachedSource: false });
    await recorder.observeFirstMessage("chat-1", "m1", "Write the spec", async () => ({ action: "spec", family: "write", confidence: 0.9 }));
    expect(await recorder.sweep(5000)).toBe(1);
    expect(out[0]).toMatchObject({ externalId: externalIdOf(OFFICE, "chat-1"), toolKey: "office", actionKey: "spec" });
  });
});
