/*
 * How often the labeller names the right cell, on held-out sentences in all three languages.
 *
 *   pnpm --filter @redrob-labs/route-labeller eval
 *
 * The held-out set (eval/held-out.json) is written separately from the lexicon's examples, so the
 * prototypes never saw it. Reports top-1 and top-3 (the label or one of its runners-up, which Console
 * tries in order) for the full labeller and for the lexical pass alone, per language.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadRouteLabeller } from "../src/node.ts";
import { LEXICON, RouteLabeller } from "../src/index.ts";

type Case = { text: string; cell: string; language: string };
const cases = JSON.parse(await readFile(join(import.meta.dir, "..", "eval", "held-out.json"), "utf8")) as Case[];
const directory = process.env.REDROB_ROUTE_MODEL_DIR ?? join(import.meta.dir, "..", ".route-model");
const { labeller, reason } = await loadRouteLabeller({ directory });
if (reason) throw new Error(`the embedding pass did not load: ${reason}`);
const lexical = new RouteLabeller(LEXICON, null, null);

async function score(subject: RouteLabeller) {
  const byLanguage: Record<string, { n: number; top1: number; top3: number }> = {};
  for (const item of cases) {
    const label = await subject.label(item.text);
    const ranked = [`${label.profession}/${label.task}`, ...label.candidates.map((c) => `${c.profession}/${c.task}`)];
    const row = (byLanguage[item.language] ??= { n: 0, top1: 0, top3: 0 });
    row.n += 1;
    if (ranked[0] === item.cell) row.top1 += 1;
    if (ranked.slice(0, 3).includes(item.cell)) row.top3 += 1;
  }
  return byLanguage;
}

for (const [name, subject] of [["embedding + lexical", labeller], ["lexical only", lexical]] as const) {
  const result = await score(subject);
  const all = Object.values(result).reduce((a, r) => ({ n: a.n + r.n, top1: a.top1 + r.top1, top3: a.top3 + r.top3 }), { n: 0, top1: 0, top3: 0 });
  console.log(`\n${name}`);
  for (const [language, row] of Object.entries({ ...result, all })) {
    console.log(`  ${language.padEnd(4)} n=${String(row.n).padStart(3)}  top-1 ${(100 * row.top1 / row.n).toFixed(1)}%  top-3 ${(100 * row.top3 / row.n).toFixed(1)}%`);
  }
}
