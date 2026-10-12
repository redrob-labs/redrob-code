/*
 * Builds src/prototypes.json: one vector per ModelGuide cell, the mean of the embeddings of that
 * cell's example sentences (every language) and its English task terms, at unit length.
 *
 *   pnpm --filter @redrob-labs/route-labeller model && pnpm --filter @redrob-labs/route-labeller prototypes
 *
 * Committed rather than computed at load, because loading would otherwise embed every example on
 * every start, a few seconds of CPU nobody needs to spend twice. Rebuild after the lexicon changes;
 * the labeller refuses prototypes built with a different model.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { LEXICON, MANIFEST, normalise, SentenceEncoder, type OrtRuntime } from "../src/index.ts";

const directory = process.env.REDROB_ROUTE_MODEL_DIR ?? join(import.meta.dir, "..", ".route-model");
const read = (file: string) => readFile(join(directory, file)).then((buffer) => new Uint8Array(buffer));
const ort = (await import("onnxruntime-node")) as unknown as OrtRuntime;
const encoder = await SentenceEncoder.load(
  {
    manifest: MANIFEST,
    model: await read(MANIFEST.model.file),
    tokenizer: await read(MANIFEST.tokenizer.file),
    dense: await read(MANIFEST.dense.file),
  },
  ort,
);

const cells: Record<string, number[]> = {};
for (const [cell, entry] of Object.entries(LEXICON.tasks)) {
  const sentences = [
    ...(entry.examples?.en ?? []),
    ...(entry.examples?.ko ?? []),
    ...(entry.examples?.hi ?? []),
    (entry.en ?? []).join(", "),
  ].filter((sentence) => sentence.trim());
  const sum = new Float32Array(MANIFEST.dimensions);
  for (const sentence of sentences) {
    const vector = await encoder.embed(sentence);
    for (let k = 0; k < sum.length; k += 1) sum[k]! += vector[k]!;
  }
  cells[cell] = Array.from(normalise(sum), (value) => Math.round(value * 1e5) / 1e5);
}

await writeFile(
  join(import.meta.dir, "..", "src", "prototypes.json"),
  `${JSON.stringify({
    model: encoder.id,
    lexiconVersion: LEXICON.version,
    edition: LEXICON.edition,
    dimensions: MANIFEST.dimensions,
    cells,
  })}\n`,
);
console.log(`${Object.keys(cells).length} prototypes written for ${encoder.id}`);
