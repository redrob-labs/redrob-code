import { describe, expect, test } from "bun:test";

import { WORK_SAMPLES } from "../eval/work-samples.js";
import { WORK_ACTIONS } from "../../src/index.js";
import { TRAINING_EXAMPLES } from "./index.js";
import { TUNING_EXAMPLES } from "./tuning.js";

const normal = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

describe("work classifier training set", () => {
  test("shares nothing with the evaluation set, and the tuning slice shares nothing with either", () => {
    const evaluation = WORK_SAMPLES.map((s) => normal(s.text));
    const training = TRAINING_EXAMPLES.map((e) => normal(e.text));
    const leaks = [...TRAINING_EXAMPLES, ...TUNING_EXAMPLES].filter((example) => {
      const t = normal(example.text);
      // Containment only for phrases long enough to be a message of their own: "translate this" is in the
      // evaluation set, and a longer request that starts with those words is not a copy of it.
      return evaluation.some((e) => e === t || (t.length >= 20 && e.includes(t)) || (e.length >= 20 && t.includes(e)));
    });
    expect(leaks.map((l) => l.text)).toEqual([]);
    expect(TUNING_EXAMPLES.filter((e) => training.includes(normal(e.text))).map((e) => e.text)).toEqual([]);
  });

  test("no example appears twice", () => {
    const texts = TRAINING_EXAMPLES.map((e) => normal(e.text));
    expect(texts.filter((t, i) => texts.indexOf(t) !== i)).toEqual([]);
  });

  test("covers every kind of work, at least 30 in each language", () => {
    for (const action of WORK_ACTIONS) {
      for (const lang of ["en", "ko"]) {
        expect(TRAINING_EXAMPLES.filter((e) => e.action === action && e.lang === lang).length).toBeGreaterThanOrEqual(30);
      }
    }
  });

  test("Korean examples are Korean, English ones are not", () => {
    for (const e of [...TRAINING_EXAMPLES, ...TUNING_EXAMPLES]) {
      if (e.lang === "ko") expect(`${/[가-힣]/.test(e.text)} ${e.text}`).toBe(`true ${e.text}`);
      else expect(`${/[가-힣]/.test(e.text)} ${e.text}`).toBe(`false ${e.text}`);
    }
  });

  test("has learning and not-work examples in both languages", () => {
    for (const lang of ["en", "ko"]) {
      expect(TRAINING_EXAMPLES.filter((e) => e.learn && e.lang === lang).length).toBe(25);
      expect(TRAINING_EXAMPLES.filter((e) => e.action === null && !e.learn && e.lang === lang).length).toBe(25);
    }
  });
});
