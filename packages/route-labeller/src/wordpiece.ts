/*
 * BERT WordPiece tokenizer with character offsets, shared by the privacy detector and the route
 * labeller (both run BERT-family encoders on the person's machine).
 *
 * Matches Hugging Face `tokenizers` for the configuration every candidate model uses
 * (BertNormalizer clean_text + handle_chinese_chars, no lowercasing, no accent stripping;
 * BertPreTokenizer; WordPiece with `##`, 100 characters per word at most). wordpiece.test.ts pins
 * it against ids and offsets produced by the Python library, so a drift shows up as a failing test,
 * not as quietly worse detection.
 *
 * Offsets are UTF-16 indexes into the input string, the way JavaScript slices it.
 */

export type WordPieceToken = {
  id: number;
  /** Start and end in the input, UTF-16 units. */
  start: number;
  end: number;
  /** True for a `##` piece that continues the previous one inside the same word. */
  continuation: boolean;
  piece: string;
};

export type WordPieceConfig = {
  vocab: ReadonlyMap<string, number>;
  unkToken?: string;
  prefix?: string;
  maxCharsPerWord?: number;
};

const isWhitespace = (cp: number) =>
  cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d || /\s/u.test(String.fromCodePoint(cp));

/** What BertNormalizer's clean_text drops: NUL, U+FFFD and control characters other than whitespace. */
function isDropped(cp: number): boolean {
  if (cp === 0 || cp === 0xfffd) return true;
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
  return /\p{Cc}|\p{Cf}/u.test(String.fromCodePoint(cp));
}

/** CJK ideographs, which BERT splits one per word. Hangul is not in these ranges. */
function isChinese(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

function isPunctuation(cp: number): boolean {
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return /\p{P}/u.test(String.fromCodePoint(cp));
}

/** Words with their offsets, after normalisation and pre-tokenisation. */
export function preTokenize(text: string): Array<{ word: string; start: number; end: number }> {
  const words: Array<{ word: string; start: number; end: number }> = [];
  let word = "";
  let start = 0;
  let end = 0;
  const flush = () => {
    if (word) words.push({ word, start, end });
    word = "";
  };
  let index = 0;
  while (index < text.length) {
    const cp = text.codePointAt(index)!;
    const width = cp > 0xffff ? 2 : 1;
    if (isDropped(cp)) {
      // Dropped characters vanish without splitting the word around them, as in the reference.
    } else if (isWhitespace(cp)) {
      flush();
    } else if (isChinese(cp) || isPunctuation(cp)) {
      flush();
      words.push({ word: String.fromCodePoint(cp), start: index, end: index + width });
    } else {
      if (!word) start = index;
      word += String.fromCodePoint(cp);
      end = index + width;
    }
    index += width;
  }
  flush();
  return words;
}

export class WordPiece {
  private readonly vocab: ReadonlyMap<string, number>;
  private readonly unkId: number;
  private readonly prefix: string;
  private readonly maxChars: number;

  constructor(config: WordPieceConfig) {
    this.vocab = config.vocab;
    const unk = config.unkToken ?? "[UNK]";
    const unkId = this.vocab.get(unk);
    if (unkId === undefined) throw new Error(`vocabulary has no ${unk}`);
    this.unkId = unkId;
    this.prefix = config.prefix ?? "##";
    this.maxChars = config.maxCharsPerWord ?? 100;
  }

  id(token: string): number {
    const id = this.vocab.get(token);
    if (id === undefined) throw new Error(`vocabulary has no ${token}`);
    return id;
  }

  tokenize(text: string): WordPieceToken[] {
    const out: WordPieceToken[] = [];
    for (const { word, start, end } of preTokenize(text)) {
      // Offsets inside a word follow its characters; dropped characters only occur between words
      // in practice, so a word's text is contiguous in the input when its span length matches.
      const contiguous = end - start === word.length;
      const chars = Array.from(word);
      if (chars.length > this.maxChars) {
        out.push({ id: this.unkId, start, end, continuation: false, piece: "[UNK]" });
        continue;
      }
      const pieces: WordPieceToken[] = [];
      let charIndex = 0;
      let unitOffset = 0;
      let failed = false;
      while (charIndex < chars.length) {
        let endChar = chars.length;
        let found: { id: number; piece: string } | null = null;
        while (endChar > charIndex) {
          const sub = chars.slice(charIndex, endChar).join("");
          const piece = charIndex > 0 ? `${this.prefix}${sub}` : sub;
          const id = this.vocab.get(piece);
          if (id !== undefined) {
            found = { id, piece };
            break;
          }
          endChar -= 1;
        }
        if (!found) {
          failed = true;
          break;
        }
        const units = chars.slice(charIndex, endChar).join("").length;
        pieces.push({
          id: found.id,
          start: contiguous ? start + unitOffset : start,
          end: contiguous ? start + unitOffset + units : end,
          continuation: charIndex > 0,
          piece: found.piece,
        });
        unitOffset += units;
        charIndex = endChar;
      }
      if (failed) out.push({ id: this.unkId, start, end, continuation: false, piece: "[UNK]" });
      else out.push(...pieces);
    }
    return out;
  }
}

/** The vocabulary from a Hugging Face tokenizer.json, which every candidate ships. */
export function vocabFromTokenizerJson(json: unknown): Map<string, number> {
  const model = (json as { model?: { type?: string; vocab?: Record<string, number> } }).model;
  if (model?.type !== "WordPiece" || !model.vocab) throw new Error("tokenizer.json is not a WordPiece tokenizer");
  return new Map(Object.entries(model.vocab));
}
