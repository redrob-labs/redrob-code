/** Terms per working language, matched case-insensitively. */
export type LexiconTerms = Partial<Record<"en" | "ko" | "hi", string[]>>;

/**
 * The words the labeller reads a request with, per ModelGuide cell. Shipped with this package as
 * lexicon.json and copied by the Console API's guide:sync into each edition, so both label alike.
 */
export type Lexicon = {
  version: number;
  /** The ModelGuide edition the lexicon was written against. */
  edition: string;
  /** The `profession/task` a request with nothing recognisable in it is labelled as. */
  default: string;
  /** Profession ids a person or app may use that mean one of the guide's, e.g. `salesperson`. */
  professionAliases: Record<string, string>;
  professions: Record<string, LexiconTerms>;
  /** Keyed `profession/task`. `examples` are what the embedding pass compares a request against. */
  tasks: Record<string, LexiconTerms & { examples?: LexiconTerms }>;
};

/** What the labeller says a request is, in the shape Console's `redrob.route` takes. */
export type RouteLabel = {
  profession: string;
  task: string;
  edition: string;
  /**
   * `mode` is whether the embedding model ran (`embedding`) or the labeller read words alone because
   * the model is not installed or not downloaded yet (`lexical`). Console routes Redrob Auto on the
   * ModelGuide only for `embedding`; a `lexical` label routes on the legacy table, and is recorded.
   */
  labeller: { id: string; version: string; confidence: number; mode: "embedding" | "lexical" };
  /** The runners-up, best first. Console tries them before its own nearest-cell rules. */
  candidates: Array<{ profession: string; task: string; score: number }>;
};

/** The manifest of the embedding model the labeller runs. Every file is pinned by SHA-256. */
export type RouteModelManifest = {
  id: string;
  revision: string;
  license: string;
  dimensions: number;
  /** Tokens per request read, the newest first. Longer text is cut, not windowed. */
  maxTokens: number;
  model: { file: string; sha256: string; url?: string };
  tokenizer: { file: string; sha256: string; url?: string };
  /** The sentence-transformers Dense projection after mean pooling, as safetensors. */
  dense: { file: string; sha256: string; url?: string };
};

/** The part of onnxruntime's API the labeller uses; onnxruntime-node and -web both provide it. */
export type OrtRuntime = {
  InferenceSession: {
    create(model: Uint8Array, options?: Record<string, unknown>): Promise<OrtSession>;
  };
  Tensor: new (type: "int64", data: BigInt64Array, dims: readonly number[]) => unknown;
};

export type OrtSession = {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown; dims: readonly number[] }>>;
  inputNames: readonly string[];
};

/** Per-cell prototype vectors: the mean of each cell's example and label embeddings, unit length. */
export type Prototypes = {
  /** Which model and lexicon produced them; a mismatch means they must be rebuilt. */
  model: string;
  lexiconVersion: number;
  edition: string;
  dimensions: number;
  cells: Record<string, number[]>;
};
