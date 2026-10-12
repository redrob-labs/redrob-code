import { describe, expect, test } from "bun:test";

import { WORK_ACTIONS, WORK_TASKS } from "../../src/index.js";
import { WORK_SAMPLES } from "./work-samples.js";

describe("work classifier evaluation set", () => {
  test("every label is one the console accepts", () => {
    for (const sample of WORK_SAMPLES) {
      if (sample.action === null) {
        expect(sample.task).toBeNull();
        continue;
      }
      expect(WORK_ACTIONS).toContain(sample.action);
      if (sample.task !== null) expect(WORK_TASKS[sample.action]).toContain(sample.task);
    }
  });

  test("ids are unique and no text appears twice", () => {
    expect(new Set(WORK_SAMPLES.map((s) => s.id)).size).toBe(WORK_SAMPLES.length);
    expect(new Set(WORK_SAMPLES.map((s) => s.text)).size).toBe(WORK_SAMPLES.length);
  });

  test("every kind of work has 8 plain samples in each language", () => {
    for (const action of WORK_ACTIONS) {
      for (const lang of ["en", "ko"]) {
        const plain = WORK_SAMPLES.filter((s) => s.source === "plain" && s.action === action && s.lang === lang);
        expect(plain.length).toBe(8);
      }
    }
  });

  test("every task appears in both languages", () => {
    for (const [action, tasks] of Object.entries(WORK_TASKS)) {
      for (const task of tasks) {
        for (const lang of ["en", "ko"]) {
          const found = WORK_SAMPLES.some((s) => s.action === action && s.task === task && s.lang === lang);
          expect(`${action}.${task} ${lang} ${found}`).toBe(`${action}.${task} ${lang} true`);
        }
      }
    }
  });

  test("briefs, learning asks and not-about-work cases are all represented", () => {
    const count = (keep: (s: (typeof WORK_SAMPLES)[number]) => boolean) => WORK_SAMPLES.filter(keep).length;
    expect(count((s) => s.brief)).toBeGreaterThanOrEqual(100);
    expect(count((s) => !s.brief)).toBeGreaterThanOrEqual(100);
    expect(count((s) => s.learn)).toBeGreaterThanOrEqual(30);
    expect(count((s) => s.action === null)).toBeGreaterThanOrEqual(20);
    expect(count((s) => s.lang === "mixed")).toBeGreaterThanOrEqual(5);
  });
});
