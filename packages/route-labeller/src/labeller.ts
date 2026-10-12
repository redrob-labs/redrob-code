/*
 * The route labeller: which ModelGuide profession and task a request is, decided on the person's
 * machine and sent to Console as `redrob.route`, which Redrob Auto routes on.
 *
 * Two passes, combined. The embedding pass compares the request with each cell's prototype - the mean
 * of its example sentences in English, Korean and Hindi - so "이 계약서 좀 봐줘" lands on contract
 * review without the words matching any list. The lexical pass, the same one the Console API runs on
 * unlabelled requests, adds what the words say outright. Either alone is weaker: the encoder blurs
 * neighbouring tasks of one profession, the word list misses anything phrased its own way.
 *
 * Local by construction. The text never leaves the machine for this; only the two ids and the
 * runners-up are sent, alongside a prompt that was going to Console anyway.
 */
import { cosine, type SentenceEncoder } from "./encoder.js";
import { canonicalProfession, scoreLexically } from "./lexical.js";
import type { Lexicon, Prototypes, RouteLabel } from "./types.js";

export const LABELLER_ID = "route-labeller";
export const LABELLER_VERSION = "1.0.0";

/** How much one matched term is worth against cosine similarity. 0.06-0.15 is a plateau on `pnpm eval`. */
const LEXICAL_WEIGHT = 0.1;
/** Matched terms past this add nothing: a long request should not win on length alone. */
const LEXICAL_CAP = 4;
/** Softmax temperature for confidence. Low, because prototype similarities sit close together. */
const TEMPERATURE = 0.03;
const CANDIDATES = 4;

export type LabelOptions = {
  /** A profession the person chose (a playbook's, or their own setting). Restricts to its tasks. */
  profession?: string | null;
  /** Whether the request is code, which the caller's own classifier knows better than words. */
  coding?: boolean;
};

export class RouteLabeller {
  constructor(
    readonly lexicon: Lexicon,
    private readonly prototypes: Prototypes | null,
    private readonly encoder: SentenceEncoder | null,
  ) {
    if (prototypes && encoder && prototypes.model !== encoder.id) {
      throw new Error(`prototypes were built with ${prototypes.model}, not ${encoder.id}`);
    }
  }

  /** Which passes are running. Without the model it is the lexical pass alone, and says so. */
  get mode(): "embedding" | "lexical" {
    return this.encoder && this.prototypes ? "embedding" : "lexical";
  }

  async label(prompt: string, options: LabelOptions = {}): Promise<RouteLabel> {
    const profession = canonicalProfession(this.lexicon, options.profession);
    const lexical = scoreLexically(this.lexicon, prompt, { profession, coding: options.coding });

    let vector: Float32Array | null = null;
    if (this.encoder && this.prototypes && prompt.trim()) {
      vector = await this.encoder.embed(prompt);
    }

    const scored = lexical.map((cell) => {
      const key = `${cell.profession}/${cell.task}`;
      const prototype = this.prototypes?.cells[key];
      const similarity = vector && prototype ? cosine(vector, prototype) : 0;
      return { ...cell, score: similarity + LEXICAL_WEIGHT * Math.min(cell.score, LEXICAL_CAP) };
    });
    // Stable sort: equal scores keep the lexicon's order, so one text always lands on one cell.
    scored.sort((a, b) => b.score - a.score);

    const nothingMatched = !vector && scored.every((cell) => cell.score === 0);
    if (nothingMatched || scored.length === 0) {
      const own = profession ? Object.keys(this.lexicon.tasks).find((key) => key.startsWith(`${profession}/`)) : null;
      const [p, t] = (own ?? this.lexicon.default).split("/") as [string, string];
      return this.result(p, t, 0, []);
    }

    const top = scored.slice(0, CANDIDATES + 1);
    const weights = top.map((cell) => Math.exp((cell.score - top[0]!.score) / TEMPERATURE));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const confidence = weights[0]! / total;
    return this.result(
      top[0]!.profession,
      top[0]!.task,
      confidence,
      top.slice(1).map((cell, index) => ({
        profession: cell.profession,
        task: cell.task,
        score: round(weights[index + 1]! / total),
      })),
    );
  }

  private result(profession: string, task: string, confidence: number, candidates: RouteLabel["candidates"]): RouteLabel {
    return {
      profession,
      task,
      edition: this.lexicon.edition,
      labeller: {
        id: `${LABELLER_ID}/${this.mode}`,
        version: LABELLER_VERSION,
        confidence: round(confidence),
        mode: this.mode,
      },
      candidates,
    };
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** The label as the body field Console reads: `{ redrob: { route } }`. */
export function routeBody(label: RouteLabel): { redrob: { route: RouteLabel } } {
  return { redrob: { route: label } };
}
