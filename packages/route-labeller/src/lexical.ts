/*
 * The lexical pass: which ModelGuide cell a request's words name, from the lexicon.
 *
 * The same algorithm the Console API runs on a request that arrives without labels
 * (redrob-console apps/api/src/inference/guide/labeller.ts), on the same lexicon, which the API's
 * guide:sync copies from this package. Keeping the two in step is what makes one request label the
 * same way on the person's machine and in the cloud. The embedding pass in labeller.ts sits on top
 * of this; this alone is the fallback when the model is not installed.
 */
import type { Lexicon, LexiconTerms } from "./types.js";

/** A term in a script without spaces between words, or a phrase, is matched as a substring. */
const NO_WORD_BOUNDARY = /[\u0900-\u097f\uac00-\ud7a3\u3040-\u30ff\u4e00-\u9fff\s/&]/;

export function matches(text: string, term: string): boolean {
  const needle = term.toLowerCase();
  if (NO_WORD_BOUNDARY.test(needle)) return text.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A plural or a common inflection still names the thing: "clauses", "invoiced", "screening".
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?:s|es|ed|d|ing)?($|[^\\p{L}\\p{N}])`, "u").test(text);
}

function termsOf(terms: LexiconTerms | undefined): string[] {
  if (!terms) return [];
  return [...(terms.en ?? []), ...(terms.ko ?? []), ...(terms.hi ?? [])];
}

function weigh(text: string, terms: string[]): number {
  let score = 0;
  for (const term of terms) if (matches(text, term)) score += 1;
  return score;
}

export type CellScore = { profession: string; task: string; score: number };

/** A profession id as the lexicon knows it, through its aliases. Null when it names none. */
export function canonicalProfession(lexicon: Lexicon, id: string | undefined | null): string | null {
  if (!id) return null;
  const key = id.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (lexicon.professions[key]) return key;
  const alias = lexicon.professionAliases[key];
  return alias && lexicon.professions[alias] ? alias : null;
}

/**
 * Every cell's lexical score, in the lexicon's order. A task term counts double a profession term:
 * "review this NDA" names the work, "lawyer" only names who is likely doing it.
 */
export function scoreLexically(
  lexicon: Lexicon,
  prompt: string,
  options: { profession?: string | null; coding?: boolean } = {},
): CellScore[] {
  const text = (prompt ?? "").normalize("NFC").toLowerCase();
  const professionScores = new Map<string, number>();
  const out: CellScore[] = [];
  for (const cell of Object.keys(lexicon.tasks)) {
    const [profession, task] = cell.split("/") as [string, string];
    if (options.profession && profession !== options.profession) continue;
    if (!professionScores.has(profession)) {
      professionScores.set(profession, weigh(text, termsOf(lexicon.professions[profession])));
    }
    let score = 2 * weigh(text, termsOf(lexicon.tasks[cell])) + professionScores.get(profession)!;
    if (options.coding && profession === "engineer") score += 1;
    out.push({ profession, task, score });
  }
  return out;
}

/** The best lexical cell, or the lexicon default when nothing matched. Ties keep lexicon order. */
export function labelLexically(
  lexicon: Lexicon,
  prompt: string,
  options: { profession?: string | null; coding?: boolean } = {},
): CellScore {
  const scored = scoreLexically(lexicon, prompt, options).filter((cell) => cell.score > 0);
  scored.sort((a, b) => b.score - a.score);
  if (scored[0]) return scored[0];
  if (options.profession) {
    const own = Object.keys(lexicon.tasks).find((cell) => cell.startsWith(`${options.profession}/`));
    if (own) {
      const [profession, task] = own.split("/") as [string, string];
      return { profession, task, score: 0 };
    }
  }
  const [profession, task] = lexicon.default.split("/") as [string, string];
  return { profession, task, score: 0 };
}
