/*
 * Download on first use: puts the files MANIFEST pins into a cache folder, verified, without ever
 * holding the model in memory. For apps that do not bundle the model (Office); Cowork bundles it.
 *
 * Each file is streamed to `<file>.partial` and hashed as it is written. A partial left by an earlier
 * attempt is resumed with a byte range, and its bytes are hashed again first, so a resumed file is
 * verified end to end like a fresh one. A file is renamed into place only when its SHA-256 matches;
 * a mismatch deletes the partial, so a bad range cannot be resumed forever. Nothing here trusts the
 * network: the release URL is just where the bytes come from.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statfsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { MANIFEST, type WorkModelManifest } from "./classifier.js";

/** Free space required before a download starts: the files, plus room for the OS and the app. */
export const MIN_FREE_BYTES = 600 * 1024 * 1024;

export type DownloadProgress = { file: string; received: number; total: number | null };

export type EnsureOptions = {
  manifest?: WorkModelManifest;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  onProgress?: (progress: DownloadProgress) => void;
  /** Bytes free on the cache's volume; defaults to statfs. */
  freeBytes?: (directory: string) => number;
  signal?: AbortSignal;
};

export class WorkModelDownloadError extends Error {}

/** The folder a revision's files live in, under the app's cache root. */
export function modelDirectory(cacheRoot: string, manifest: WorkModelManifest = MANIFEST): string {
  return join(cacheRoot, manifest.revision);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Whether every pinned file is in `directory` and hashes to the manifest. */
export async function modelPresent(directory: string, manifest: WorkModelManifest = MANIFEST): Promise<boolean> {
  for (const entry of [manifest.model, manifest.tokenizer]) {
    const path = join(directory, entry.file);
    if (!existsSync(path) || (await hashFile(path)) !== entry.sha256) return false;
  }
  return true;
}

const defaultFreeBytes = (directory: string): number => {
  const stats = statfsSync(directory);
  return stats.bavail * stats.bsize;
};

async function downloadOne(directory: string, entry: WorkModelManifest["model"], options: EnsureOptions): Promise<void> {
  const target = join(directory, entry.file);
  if (existsSync(target) && (await hashFile(target)) === entry.sha256) return;
  const partial = `${target}.partial`;
  const offset = existsSync(partial) ? (await stat(partial)).size : 0;
  const response = await (options.fetch ?? fetch)(entry.url, {
    redirect: "follow",
    headers: offset ? { Range: `bytes=${offset}-` } : {},
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok || !response.body) throw new WorkModelDownloadError(`${entry.url} answered ${response.status}`);
  // 206 continues the partial; anything else is the whole file, so it starts again.
  const resumed = offset > 0 && response.status === 206;
  const hash = createHash("sha256");
  if (resumed) for await (const chunk of createReadStream(partial)) hash.update(chunk);
  await stream(response, partial, hash, resumed ? offset : 0, entry, options);
  const digest = hash.digest("hex");
  if (digest !== entry.sha256) {
    await rm(partial, { force: true });
    throw new WorkModelDownloadError(`${entry.file} does not match the pinned SHA-256 (expected ${entry.sha256}, got ${digest})`);
  }
  await rename(partial, target);
}

async function stream(
  response: Response,
  partial: string,
  hash: ReturnType<typeof createHash>,
  offset: number,
  entry: WorkModelManifest["model"],
  options: EnsureOptions,
): Promise<void> {
  const length = Number(response.headers.get("content-length"));
  const total = Number.isFinite(length) && length > 0 ? offset + length : null;
  const out = createWriteStream(partial, { flags: offset ? "a" : "w" });
  let received = offset;
  try {
    const body = response.body;
    if (!body) throw new WorkModelDownloadError(`${entry.url} sent no body`);
    const reader = body.getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      const chunk = read.value;
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
      options.onProgress?.({ file: entry.file, received, total });
    }
  } finally {
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
  }
}

/**
 * Makes the pinned model present and verified under `cacheRoot`, downloading what is missing, and
 * removes the folders of other revisions. Returns the folder to load it from. Throws on too little
 * space, a refused or broken download, or bytes that do not match; the caller retries later.
 */
export async function ensureWorkModel(cacheRoot: string, options: EnsureOptions = {}): Promise<string> {
  const manifest = options.manifest ?? MANIFEST;
  const directory = modelDirectory(cacheRoot, manifest);
  await mkdir(directory, { recursive: true });
  if (await modelPresent(directory, manifest)) return directory;
  const free = (options.freeBytes ?? defaultFreeBytes)(directory);
  if (free < MIN_FREE_BYTES) {
    throw new WorkModelDownloadError(`only ${Math.floor(free / 1024 / 1024)} MB free; the work model needs ${MIN_FREE_BYTES / 1024 / 1024} MB`);
  }
  for (const entry of [manifest.tokenizer, manifest.model]) await downloadOne(directory, entry, options);
  for (const name of await readdir(cacheRoot)) {
    if (name !== manifest.revision) await rm(join(cacheRoot, name), { recursive: true, force: true });
  }
  return directory;
}

export type WorkModelState =
  | { state: "absent" }
  | { state: "downloading"; received: number; total: number | null }
  | { state: "ready"; directory: string }
  | { state: "failed"; reason: string; retryAt: number };

const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

/**
 * Fetches the model in the background, once, when the app asks: after a chat has finished, never at
 * start-up or while one streams. A failure is retried on the next request after a growing wait
 * (1 min, 5 min, 30 min, then every 2 h), and never surfaces as an error in a chat. `state()` is
 * what Settings shows.
 */
export class WorkModelFetcher {
  private current: WorkModelState = { state: "absent" };
  private running: Promise<string | null> | null = null;
  private failures = 0;
  private readonly listeners = new Set<(state: WorkModelState) => void>();

  constructor(
    private readonly cacheRoot: string,
    private readonly options: EnsureOptions & { now?: () => number } = {},
  ) {}

  state(): WorkModelState {
    return this.current;
  }

  onChange(listener: (state: WorkModelState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(state: WorkModelState): void {
    this.current = state;
    for (const listener of this.listeners) listener(state);
  }

  /** The folder when the model is ready; otherwise starts or continues fetching it and returns null. */
  request(): Promise<string | null> {
    if (this.current.state === "ready") return Promise.resolve(this.current.directory);
    const now = (this.options.now ?? Date.now)();
    if (this.current.state === "failed" && now < this.current.retryAt) return Promise.resolve(null);
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<string | null> {
    this.set({ state: "downloading", received: 0, total: null });
    const totals = new Map<string, number>();
    try {
      const directory = await ensureWorkModel(this.cacheRoot, {
        ...this.options,
        onProgress: (progress) => {
          totals.set(progress.file, progress.received);
          const received = [...totals.values()].reduce((sum, value) => sum + value, 0);
          this.set({ state: "downloading", received, total: progress.total });
          this.options.onProgress?.(progress);
        },
      });
      this.failures = 0;
      this.set({ state: "ready", directory });
      return directory;
    } catch (error) {
      const wait = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)]!;
      this.failures += 1;
      this.set({ state: "failed", reason: error instanceof Error ? error.message : String(error), retryAt: (this.options.now ?? Date.now)() + wait });
      return null;
    }
  }
}
