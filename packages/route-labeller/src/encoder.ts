/*
 * A multilingual sentence encoder on onnxruntime: distiluse-base-multilingual-cased-v2.
 *
 * Chosen because it uses the same BERT WordPiece tokenizer the privacy detector already ships
 * (wordpiece.ts, unchanged), so the labeller needs no second tokenizer implementation, and because it
 * was trained so that a sentence and its translation land close together across fifty languages,
 * Korean and Hindi among them. That is what lets one set of prototype sentences cover all three
 * working languages the ModelGuide ranks.
 *
 * The pipeline is the model's own: token embeddings, mean pooling over the attention mask, then the
 * Dense 768 -> 512 projection with tanh. The ONNX export covers the transformer; pooling and the
 * projection are done here, from the weights the model publishes.
 *
 * Runtime-neutral: bytes in, no filesystem, no node:crypto. Integrity uses WebCrypto, which Node 20+,
 * Electron and every webview have, so the same code runs in redrob-server, Office's main process and
 * Design's webview.
 */
import type { OrtRuntime, OrtSession, RouteModelManifest } from "./types.js";
import { vocabFromTokenizerJson, WordPiece } from "./wordpiece.js";

export class RouteModelIntegrityError extends Error {}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Dense = { weight: Float32Array; bias: Float32Array; inputs: number; outputs: number };

/** Reads the projection out of a safetensors file: an 8-byte header length, a JSON header, the data. */
export function readDense(bytes: Uint8Array): Dense {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = Number(view.getBigUint64(0, true));
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength))) as Record<
    string,
    { dtype: string; shape: number[]; data_offsets: [number, number] }
  >;
  const base = 8 + headerLength;
  const tensor = (name: string) => {
    const entry = header[name];
    if (!entry || entry.dtype !== "F32") throw new Error(`dense weights have no F32 ${name}`);
    const [from, to] = entry.data_offsets;
    const copy = bytes.slice(base + from, base + to);
    return { data: new Float32Array(copy.buffer, copy.byteOffset, (to - from) / 4), shape: entry.shape };
  };
  const weight = tensor("linear.weight");
  const bias = tensor("linear.bias");
  const [outputs, inputs] = weight.shape as [number, number];
  return { weight: weight.data, bias: bias.data, inputs, outputs };
}

export type EncoderFiles = { manifest: RouteModelManifest; model: Uint8Array; tokenizer: Uint8Array; dense: Uint8Array };

export class SentenceEncoder {
  readonly id: string;

  private constructor(
    private readonly ort: OrtRuntime,
    private readonly session: OrtSession,
    private readonly tokenizer: WordPiece,
    private readonly dense: Dense,
    readonly manifest: RouteModelManifest,
  ) {
    this.id = `${manifest.id}@${manifest.revision.slice(0, 8)}`;
  }

  /** Verifies every file against the manifest before any of it is parsed or run. */
  static async load(
    files: EncoderFiles,
    ort: OrtRuntime,
    options: { threads?: number } = {},
  ): Promise<SentenceEncoder> {
    const { manifest } = files;
    const checks: Array<[string, Uint8Array, string]> = [
      ["model", files.model, manifest.model.sha256],
      ["tokenizer", files.tokenizer, manifest.tokenizer.sha256],
      ["dense", files.dense, manifest.dense.sha256],
    ];
    for (const [name, bytes, expected] of checks) {
      if ((await sha256Hex(bytes)) !== expected) {
        throw new RouteModelIntegrityError(`route model ${name} does not match its manifest`);
      }
    }
    const tokenizer = new WordPiece({
      vocab: vocabFromTokenizerJson(JSON.parse(new TextDecoder().decode(files.tokenizer))),
    });
    const session = await ort.InferenceSession.create(files.model, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      intraOpNumThreads: options.threads ?? 2,
      interOpNumThreads: 1,
    });
    return new SentenceEncoder(ort, session, tokenizer, readDense(files.dense), manifest);
  }

  /** One unit-length vector per text. Texts are encoded one at a time: requests are one sentence. */
  async embed(text: string): Promise<Float32Array> {
    const cls = this.tokenizer.id("[CLS]");
    const sep = this.tokenizer.id("[SEP]");
    const pieces = this.tokenizer.tokenize(text.normalize("NFC")).slice(0, this.manifest.maxTokens - 2);
    const ids = BigInt64Array.from([cls, ...pieces.map((token) => token.id), sep].map(BigInt));
    const dims = [1, ids.length] as const;
    const feeds: Record<string, unknown> = {
      input_ids: new this.ort.Tensor("int64", ids, dims),
      attention_mask: new this.ort.Tensor("int64", new BigInt64Array(ids.length).fill(1n), dims),
    };
    if (this.session.inputNames.includes("token_type_ids")) {
      feeds.token_type_ids = new this.ort.Tensor("int64", new BigInt64Array(ids.length), dims);
    }
    const result = await this.session.run(feeds);
    const hidden = (result.last_hidden_state ?? Object.values(result)[0])!;
    const states = hidden.data as Float32Array;
    const width = this.dense.inputs;
    const tokens = ids.length;

    // Mean pooling: every position is attended, so the mean is over all of them.
    const pooled = new Float32Array(width);
    for (let t = 0; t < tokens; t += 1) {
      for (let k = 0; k < width; k += 1) pooled[k]! += states[t * width + k]!;
    }
    for (let k = 0; k < width; k += 1) pooled[k]! /= tokens;

    const out = new Float32Array(this.dense.outputs);
    for (let o = 0; o < this.dense.outputs; o += 1) {
      let sum = this.dense.bias[o]!;
      const row = o * width;
      for (let k = 0; k < width; k += 1) sum += this.dense.weight[row + k]! * pooled[k]!;
      out[o] = Math.tanh(sum);
    }
    return normalise(out);
  }
}

export function normalise(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return vector.map((value) => value / norm);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  for (let k = 0; k < a.length; k += 1) dot += a[k]! * b[k]!;
  return dot;
}
