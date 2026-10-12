/*
 * The XLM-R SentencePiece tokenizer the work classifier's encoder (multilingual-e5-base) reads, as
 * Hugging Face `tokenizers` runs it from tokenizer.json: split out special tokens, the Precompiled
 * normalizer (SentencePiece's nmt_nfkc charsmap), then either a whitespace split (e5-base) or runs of
 * spaces collapsed (e5-small), Metaspace, Unigram Viterbi, then `<s> A </s>`. Ids match `tokenizers` exactly (test/fixtures/unigram-parity.json), because
 * the head was trained on what that library produced.
 */

import { z } from "zod";

const SPACE = "\u2581";
/** `tokenizers`' Unigram: an unknown character costs this much below the vocab's lowest score. */
const UNK_PENALTY = 10;
/** Rust's `char::is_whitespace`, which `tokenizers`' WhitespaceSplit uses; JavaScript's `\s` differs. */
const WHITESPACE = "[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";

export type UnigramPiece = { id: number; score: number };

export type UnigramOptions = {
  pieces: ReadonlyMap<string, UnigramPiece>;
  unkId: number;
  /** The lowest score in the whole vocab (a fixture may hold a subset of it). */
  minScore: number;
  /** SentencePiece's precompiled_charsmap, or null to skip normalisation. */
  charsmap: Uint8Array | null;
  /** Special tokens matched in the raw text, as `tokenizers`' added vocabulary does. */
  specials: ReadonlyMap<string, number>;
  /** Specials that take the whitespace before them (`lstrip`). */
  lstrip?: ReadonlySet<string>;
  /** Pre-tokenizer: split on whitespace, then Metaspace each word (e5-base), or Metaspace alone after
   * collapsing runs of spaces (e5-small). */
  whitespaceSplit: boolean;
  bosId: number;
  eosId: number;
};

/** SentencePiece's double-array trie over UTF-8 bytes, read as spm_precompiled reads it. */
class Charsmap {
  private readonly units: Uint32Array;
  private readonly normalized: Uint8Array;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

  constructor(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const trieBytes = view.getUint32(0, true);
    this.units = new Uint32Array(trieBytes / 4);
    for (let i = 0; i < this.units.length; i += 1) this.units[i] = view.getUint32(4 + i * 4, true);
    this.normalized = bytes.subarray(4 + trieBytes);
  }

  /** The replacement for the shortest charsmap entry `chunk` starts with, as spm_precompiled does. */
  transform(chunk: string): string | null {
    const key = this.encoder.encode(chunk);
    const units = this.units;
    const offset = (unit: number) => (unit >>> 10) << ((unit & (1 << 9)) >>> 6);
    let node = offset(units[0]!);
    for (const byte of key) {
      if (byte === 0) break;
      node ^= byte;
      const unit = units[node]!;
      if ((unit & 0x800000ff) >>> 0 !== byte) return null;
      node ^= offset(unit);
      if ((unit >>> 8) & 1) {
        const start = units[node]! & 0x7fffffff;
        let end = start;
        while (end < this.normalized.length && this.normalized[end] !== 0) end += 1;
        return this.decoder.decode(this.normalized.subarray(start, end));
      }
    }
    return null;
  }

  normalize(text: string): string {
    let out = "";
    for (const { segment } of this.graphemes.segment(text)) {
      if (this.encoder.encode(segment).length < 6) {
        const whole = this.transform(segment);
        if (whole !== null) {
          out += whole;
          continue;
        }
      }
      for (const char of segment) out += this.transform(char) ?? char;
    }
    return out;
  }
}

export class Unigram {
  private readonly charsmap: Charsmap | null;
  private readonly longest: number;
  private readonly specials: RegExp | null;

  constructor(private readonly options: UnigramOptions) {
    this.charsmap = options.charsmap ? new Charsmap(options.charsmap) : null;
    let longest = 1;
    for (const piece of options.pieces.keys()) longest = Math.max(longest, [...piece].length);
    this.longest = longest;
    const names = [...options.specials.keys()].sort((a, b) => b.length - a.length);
    const pattern = (name: string) =>
      `${options.lstrip?.has(name) ? `${WHITESPACE}*` : ""}${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    this.specials = names.length ? new RegExp(names.map(pattern).join("|"), "g") : null;
  }

  /** Token ids with `<s>` and `</s>`, at most `maxLength` of them in all. */
  encode(text: string, maxLength = 512): number[] {
    const ids: number[] = [];
    let last = 0;
    for (const match of this.specials ? text.matchAll(this.specials) : []) {
      ids.push(...this.segment(text.slice(last, match.index)), this.options.specials.get(match[0].replace(this.leading, ""))!);
      last = match.index + match[0].length;
    }
    ids.push(...this.segment(text.slice(last)));
    return [this.options.bosId, ...ids.slice(0, Math.max(0, maxLength - 2)), this.options.eosId];
  }

  private readonly leading = new RegExp(`^${WHITESPACE}+`);

  private segment(text: string): number[] {
    if (!text) return [];
    const plain = this.charsmap ? this.charsmap.normalize(text) : text;
    if (this.options.whitespaceSplit) {
      const ids: number[] = [];
      for (const word of plain.split(new RegExp(`${WHITESPACE}+`))) {
        if (!word) continue;
        const marked = word.startsWith(SPACE) ? word : SPACE + word;
        for (const piece of marked.split(new RegExp(`(?=${SPACE})`))) ids.push(...this.viterbi(piece));
      }
      return ids;
    }
    const normalized = plain.replace(/ {2,}/g, " ").replaceAll(" ", SPACE);
    if (!normalized) return [];
    const marked = normalized.startsWith(SPACE) ? normalized : SPACE + normalized;
    const ids: number[] = [];
    for (const word of marked.split(new RegExp(`(?=${SPACE})`))) ids.push(...this.viterbi(word));
    return ids;
  }

  /** Best-scoring split of one word, ties to the shorter piece first found; unknown runs fused. */
  private viterbi(word: string): number[] {
    const chars = [...word];
    const { pieces, unkId, minScore } = this.options;
    const best: Array<{ score: number; from: number; id: number } | null> = new Array(chars.length + 1).fill(null);
    best[0] = { score: 0, from: -1, id: -1 };
    for (let start = 0; start < chars.length; start += 1) {
      const here = best[start]!.score;
      let single = false;
      let piece = "";
      for (let end = start + 1; end <= Math.min(chars.length, start + this.longest); end += 1) {
        piece += chars[end - 1];
        const found = pieces.get(piece);
        if (!found) continue;
        const score = here + found.score;
        const target = best[end];
        if (!target || score > target.score) best[end] = { score, from: start, id: found.id };
        if (end === start + 1) single = true;
      }
      if (!single) {
        const score = here + minScore - UNK_PENALTY;
        const target = best[start + 1];
        if (!target || score > target.score) best[start + 1] = { score, from: start, id: unkId };
      }
    }
    const ids: number[] = [];
    for (let at = chars.length; at > 0; at = best[at]!.from) {
      const id = best[at]!.id;
      if (!(id === unkId && ids[ids.length - 1] === unkId)) ids.push(id);
    }
    return ids.reverse();
  }
}

/** Reads the parts of a `tokenizers` tokenizer.json this class needs; refuses any other kind. */
export function unigramFromTokenizerJson(json: unknown): Unigram {
  const parsed = TokenizerJson.parse(json);
  const pieces = new Map<string, UnigramPiece>();
  let minScore = Infinity;
  parsed.model.vocab.forEach(([piece, score], id) => {
    pieces.set(piece, { id, score });
    minScore = Math.min(minScore, score);
  });
  const steps = "normalizers" in parsed.normalizer ? parsed.normalizer.normalizers : [parsed.normalizer];
  const charsmap = steps.find((step) => step.type === "Precompiled")?.precompiled_charsmap;
  const special = parsed.added_tokens.filter((token) => token.special);
  const specials = new Map(special.map((token) => [token.content, token.id]));
  const lstrip = new Set(special.filter((token) => token.lstrip).map((token) => token.content));
  const pre = parsed.pre_tokenizer;
  const whitespaceSplit = pre.type === "Sequence" && pre.pretokenizers[0]?.type === "WhitespaceSplit";
  return new Unigram({
    pieces,
    unkId: parsed.model.unk_id,
    minScore,
    charsmap: charsmap ? Uint8Array.from(atob(charsmap), (char) => char.charCodeAt(0)) : null,
    specials,
    lstrip,
    whitespaceSplit,
    bosId: specials.get("<s>")!,
    eosId: specials.get("</s>")!,
  });
}

const Step = z.object({ type: z.string(), precompiled_charsmap: z.string().optional() });
const Metaspace = z.object({ type: z.literal("Metaspace"), replacement: z.literal(SPACE) });
const TokenizerJson = z.object({
  added_tokens: z.array(z.object({ id: z.number(), content: z.string(), special: z.boolean(), lstrip: z.boolean().optional() })),
  normalizer: z.union([z.object({ type: z.literal("Sequence"), normalizers: z.array(Step) }), Step]),
  pre_tokenizer: z.union([
    Metaspace,
    z.object({ type: z.literal("Sequence"), pretokenizers: z.tuple([z.object({ type: z.literal("WhitespaceSplit") }), Metaspace]) }),
  ]),
  model: z.object({ type: z.literal("Unigram"), unk_id: z.number(), vocab: z.array(z.tuple([z.string(), z.number()])) }),
});
