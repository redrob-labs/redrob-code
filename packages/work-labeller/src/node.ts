/*
 * The work classifier in Node and Electron: the model read from a folder, and the one classifier per
 * process, loaded on first use. The folder is only where to look; the files must hash to MANIFEST.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createWorkClassifier,
  MANIFEST,
  WorkModelIntegrityError,
  type OrtRuntime,
  type WorkClassifier,
  type WorkHead,
  type WorkLabel,
  type WorkModelManifest,
} from "./classifier.js";

export * from "./index.js";
export { ensureWorkModel, MIN_FREE_BYTES, modelDirectory, modelPresent, WorkModelDownloadError, WorkModelFetcher } from "./download.js";
export type { DownloadProgress, EnsureOptions, WorkModelState } from "./download.js";

export async function loadWorkClassifier(
  directory: string,
  ort: OrtRuntime,
  options: { manifest?: WorkModelManifest; head?: WorkHead; threads?: number } = {},
): Promise<WorkClassifier> {
  const pinned = options.manifest ?? MANIFEST;
  const [model, tokenizer] = await Promise.all([
    readFile(join(directory, pinned.model.file)),
    readFile(join(directory, pinned.tokenizer.file)),
  ]);
  return createWorkClassifier({ model: new Uint8Array(model), tokenizer: new Uint8Array(tokenizer) }, ort, options);
}

export type WorkClassifierStatus =
  | { state: "ready"; model: string }
  | { state: "not-loaded" }
  | { state: "absent"; reason: string }
  | { state: "failed"; reason: string };

/**
 * The one work classifier per process, loaded on first use. Without a model, or in a runtime that
 * cannot load it, sessions are labeled without a kind of work and `status()` says why; never throws.
 */
export class WorkClassifierSource {
  private loading: Promise<WorkClassifier | null> | null = null;
  private current: WorkClassifierStatus;

  constructor(
    private readonly options: {
      directory: string | null;
      manifest?: WorkModelManifest;
      loadRuntime?: () => Promise<OrtRuntime>;
      load?: typeof loadWorkClassifier;
    },
  ) {
    const { directory } = options;
    const model = (options.manifest ?? MANIFEST).model.file;
    if (!directory) this.current = { state: "absent", reason: "no work model is installed" };
    else if (!existsSync(join(directory, model))) this.current = { state: "absent", reason: "the work model folder has no model" };
    else this.current = { state: "not-loaded" };
  }

  status(): WorkClassifierStatus {
    return this.current;
  }

  get(): Promise<WorkClassifier | null> {
    if (this.current.state === "absent" || this.current.state === "failed") return Promise.resolve(null);
    this.loading ??= this.load();
    return this.loading;
  }

  /** The labels for a message, or null when there is no model or it fails. */
  async label(text: string): Promise<WorkLabel | null> {
    const classifier = await this.get();
    if (!classifier) return null;
    try {
      return await classifier.label(text);
    } catch (error) {
      this.current = { state: "failed", reason: `the work model failed: ${error instanceof Error ? error.message : String(error)}` };
      return null;
    }
  }

  private async load(): Promise<WorkClassifier | null> {
    const { directory, manifest } = this.options;
    if (!directory) return null;
    try {
      const ort = await (this.options.loadRuntime ?? loadOnnxRuntimeNode)();
      const classifier = await (this.options.load ?? loadWorkClassifier)(directory, ort, manifest ? { manifest } : {});
      this.current = { state: "ready", model: classifier.id };
      return classifier;
    } catch (error) {
      const reason =
        error instanceof WorkModelIntegrityError
          ? `the work model failed its integrity check: ${error.message}`
          : `the work model could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
      this.current = { state: "failed", reason };
      return null;
    }
  }
}

async function loadOnnxRuntimeNode(): Promise<OrtRuntime> {
  const ort: { default?: unknown } & Record<string, unknown> = await import("onnxruntime-node");
  const runtime = ort.default ?? ort;
  if (!isOrtRuntime(runtime)) throw new Error("onnxruntime-node has no InferenceSession");
  return runtime;
}

function isOrtRuntime(value: unknown): value is OrtRuntime {
  return typeof value === "object" && value !== null && "InferenceSession" in value && "Tensor" in value;
}
