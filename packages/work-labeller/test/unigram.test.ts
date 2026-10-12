import { describe, expect, test } from "bun:test";

import parity from "./fixtures/unigram-parity.json" with { type: "json" };
import { Unigram } from "../src/unigram.js";

describe("Unigram", () => {
  const specials = new Map(Object.entries(parity.specials));
  const tokenizer = new Unigram({
    pieces: new Map(Object.entries(parity.pieces).map(([piece, [id, score]]) => [piece, { id: id!, score: score! }])),
    unkId: parity.unkId,
    minScore: parity.minScore,
    charsmap: Uint8Array.from(atob(parity.charsmap), (char) => char.charCodeAt(0)),
    specials,
    lstrip: new Set(parity.lstrip),
    whitespaceSplit: true,
    bosId: specials.get("<s>")!,
    eosId: specials.get("</s>")!,
  });

  for (const sample of parity.cases) {
    test(`matches Hugging Face tokenizers: ${JSON.stringify(sample.text.slice(0, 40))}`, () => {
      expect(tokenizer.encode(sample.text, 256)).toEqual(sample.ids);
    });
  }
});
