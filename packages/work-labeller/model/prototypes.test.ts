import { describe, expect, test } from "bun:test";

import { WORK_SAMPLES } from "./eval/work-samples.js";
import { WORK_ACTIONS } from "../src/index.js";
import { WORK_PROTOTYPES } from "./prototypes.js";

const normal = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

describe("work classifier prototypes", () => {
  test("none is, or contains, a phrase of the evaluation set", () => {
    const samples = WORK_SAMPLES.map((s) => normal(s.text));
    for (const prototype of WORK_PROTOTYPES) {
      const p = normal(prototype.text);
      expect(samples.filter((s) => s === p || (p.length > 12 && s.includes(p)))).toEqual([]);
    }
  });

  test("every kind of work has at least three phrases in each language", () => {
    for (const action of WORK_ACTIONS) {
      const of = WORK_PROTOTYPES.filter((p) => p.action === action);
      expect(of.filter((p) => /[가-힣]/.test(p.text)).length).toBeGreaterThanOrEqual(3);
      expect(of.filter((p) => !/[가-힣]/.test(p.text)).length).toBeGreaterThanOrEqual(3);
    }
  });
});
