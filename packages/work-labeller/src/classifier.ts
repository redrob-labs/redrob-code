/*
 * The work classifier: which kind of work a session was (a support reply, a bug fix, ...) and its
 * family (writing, a sheet, code, design), read from its first message on the person's machine.
 * Only the labels leave it.
 *
 * A frozen multilingual-e5-base encoder (int8 ONNX, about 278 MB) turns the message into a sentence
 * embedding; two softmax heads (work-head.json, trained by model/scripts/train.py) name the kind of
 * work and the family, or say it is not
 * work. Measured in redrob-cowork docs/features/ai-work-insights/model-evaluation.md. When the kind
 * of work is named, the family is its family; when it is under its floor, the family head may still
 * name the family alone.
 *
 * Runtime-neutral: bytes in, an onnxruntime (node or web) passed in, integrity checked with WebCrypto
 * against MANIFEST before anything is parsed or run. `./node` adds reading and downloading the files.
 */
import { z } from "zod";

import manifest from "./manifest.json" with { type: "json" };
import { unigramFromTokenizerJson, type Unigram } from "./unigram.js";
import { ACTION_FAMILY, WORK_ACTIONS } from "./vocabulary.js";
import trainedHead from "./work-head.json" with { type: "json" };

export const WORK_FAMILIES = ["write", "sheet", "code", "design"] as const;
export type WorkFamily = (typeof WORK_FAMILIES)[number];
export type WorkLabel = { action: string | null; family: WorkFamily | null; confidence: number };

/** What the encoder reads at most, as in training (truncation 256). */
const MAX_TOKENS = 256;

const level = <T extends z.ZodType<string>>(name: T) =>
  z.object({
    classes: z.array(name.nullable()),
    scale: z.number(),
    floor: z.number(),
    w: z.array(z.array(z.number())),
    b: z.array(z.number()),
  });
const Head = z.object({
  prefix: z.string(),
  action: level(z.string().refine((key) => WORK_ACTIONS.includes(key), "not a kind of work")).nullable(),
  family: level(z.enum(WORK_FAMILIES)),
});
export type WorkHead = z.infer<typeof Head>;

export const WORK_HEAD: WorkHead = Head.parse(trainedHead);

const ModelFile = z.object({ file: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/), url: z.string().url() });
const Manifest = z.object({ id: z.string(), revision: z.string(), license: z.string(), model: ModelFile, tokenizer: ModelFile });
export type WorkModelManifest = z.infer<typeof Manifest>;

/** The encoder this version of the package trusts: what a download or a folder must hash to. */
export const MANIFEST: WorkModelManifest = Manifest.parse(manifest);

/** The most likely class of one head, and its probability. */
function top<C>(level: { classes: readonly C[]; scale: number; w: number[][]; b: number[] }, embedding: Float32Array) {
  const logits = level.b.map((bias, k) => {
    let sum = bias;
    for (let i = 0; i < embedding.length; i += 1) sum += embedding[i]! * level.scale * level.w[i]![k]!;
    return sum;
  });
  const peak = Math.max(...logits);
  const exps = logits.map((logit) => Math.exp(logit - peak));
  const total = exps.reduce((sum, value) => sum + value, 0);
  const best = exps.indexOf(Math.max(...exps));
  return { name: level.classes[best]!, confidence: exps[best]! / total };
}

/**
 * The labels for an L2-normalised sentence embedding. The kind of work when its head is sure enough,
 * with its family; else the family alone when that head is; else nothing (not work, or unsure).
 */
export function labelEmbedding(head: WorkHead, embedding: Float32Array): WorkLabel {
  if (head.action) {
    const action = top(head.action, embedding);
    if (action.name && action.confidence >= head.action.floor) {
      return { action: action.name, family: ACTION_FAMILY[action.name] ?? null, confidence: action.confidence };
    }
  }
  const family = top(head.family, embedding);
  return { action: null, family: family.name && family.confidence >= head.family.floor ? family.name : null, confidence: family.confidence };
}

/** Mean of the token vectors (every token is attended), then L2 normalisation. */
export function meanPool(hidden: Float32Array, tokens: number, width: number): Float32Array {
  const out = new Float32Array(width);
  for (let t = 0; t < tokens; t += 1) for (let i = 0; i < width; i += 1) out[i]! += hidden[t * width + i]! / tokens;
  const norm = Math.hypot(...out);
  for (let i = 0; i < width; i += 1) out[i]! /= norm;
  return out;
}

/** The part of onnxruntime's API the classifier uses; onnxruntime-node and onnxruntime-web both provide it. */
export type OrtRuntime = {
  InferenceSession: { create(model: Uint8Array, options?: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: "int64", data: BigInt64Array, dims: readonly number[]) => unknown;
};
export type OrtSession = {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown; dims: readonly number[] }>>;
  inputNames: readonly string[];
};

export interface WorkClassifier {
  readonly id: string;
  label(text: string): Promise<WorkLabel>;
}

export class WorkModelIntegrityError extends Error {}

export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

class OnnxWorkClassifier implements WorkClassifier {
  constructor(
    readonly id: string,
    private readonly ort: OrtRuntime,
    private readonly session: OrtSession,
    private readonly tokenizer: Unigram,
    private readonly head: WorkHead,
  ) {}

  async label(text: string): Promise<WorkLabel> {
    if (!text.trim()) return { action: null, family: null, confidence: 0 };
    const ids = BigInt64Array.from(this.tokenizer.encode(this.head.prefix + text, MAX_TOKENS).map(BigInt));
    const dims = [1, ids.length] as const;
    const feeds: Record<string, unknown> = {
      input_ids: new this.ort.Tensor("int64", ids, dims),
      attention_mask: new this.ort.Tensor("int64", new BigInt64Array(ids.length).fill(1n), dims),
    };
    if (this.session.inputNames.includes("token_type_ids")) feeds.token_type_ids = new this.ort.Tensor("int64", new BigInt64Array(ids.length), dims);
    const output = (await this.session.run(feeds)).last_hidden_state;
    if (!output || !(output.data instanceof Float32Array)) throw new Error("the work model returned no last_hidden_state");
    return labelEmbedding(this.head, meanPool(output.data, ids.length, output.dims[2]!));
  }
}

/**
 * A classifier from the model and tokenizer bytes. Both are checked against `manifest` (the
 * package's own by default) before either is parsed or run, so swapped files are refused.
 */
export async function createWorkClassifier(
  files: { model: Uint8Array; tokenizer: Uint8Array },
  ort: OrtRuntime,
  options: { manifest?: WorkModelManifest; head?: WorkHead; threads?: number } = {},
): Promise<WorkClassifier> {
  const pinned = options.manifest ?? MANIFEST;
  if ((await sha256OfBytes(files.model)) !== pinned.model.sha256) throw new WorkModelIntegrityError("work model file does not match its manifest");
  if ((await sha256OfBytes(files.tokenizer)) !== pinned.tokenizer.sha256) throw new WorkModelIntegrityError("work model tokenizer does not match its manifest");
  const tokenizer = unigramFromTokenizerJson(JSON.parse(new TextDecoder().decode(files.tokenizer)));
  const session = await ort.InferenceSession.create(files.model, {
    executionProviders: ["cpu"],
    // Basic only: exact, so the embeddings are the ones the head was trained on (train.py does the same).
    graphOptimizationLevel: "basic",
    intraOpNumThreads: options.threads ?? 1,
    interOpNumThreads: 1,
  });
  return new OnnxWorkClassifier(`${pinned.id}@${pinned.revision.slice(0, 8)}`, ort, session, tokenizer, options.head ?? WORK_HEAD);
}
