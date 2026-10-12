import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureWorkModel, MIN_FREE_BYTES, modelDirectory, WorkModelFetcher, type WorkModelManifest } from "../src/node.js";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const MODEL = new Uint8Array(300_000).map((_, i) => (i * 31) % 251);
const TOKENIZER = new TextEncoder().encode('{"model":"tok"}');
const PLENTY = () => MIN_FREE_BYTES * 2;

/** A release host like GitHub's: /release/* redirects to /assets/*, which honours byte ranges. */
type Hit = { path: string; range: string | null };
let hits: Hit[] = [];
let corrupt = false;
let ignoreRanges = false;
let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      hits.push({ path: url.pathname, range: request.headers.get("range") });
      if (url.pathname.startsWith("/release/")) return Response.redirect(`${base}/assets/${url.pathname.slice(9)}`, 302);
      const bytes = url.pathname.endsWith("model.onnx") ? (corrupt ? MODEL.map((b) => b ^ 1) : MODEL) : TOKENIZER;
      const range = /^bytes=(\d+)-$/.exec(request.headers.get("range") ?? "");
      if (range && !ignoreRanges) {
        const start = Number(range[1]);
        return new Response(bytes.slice(start), {
          status: 206,
          headers: { "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}`, "content-length": String(bytes.length - start) },
        });
      }
      return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const manifest = (): WorkModelManifest => ({
  id: "test/encoder",
  revision: "rev2",
  license: "MIT",
  model: { file: "model.onnx", sha256: sha(MODEL), url: `${base}/release/model.onnx` },
  tokenizer: { file: "tokenizer.json", sha256: sha(TOKENIZER), url: `${base}/release/tokenizer.json` },
});

const fresh = () => mkdtemp(join(tmpdir(), "work-cache-"));
const reset = () => {
  hits = [];
  corrupt = false;
  ignoreRanges = false;
};

describe("download on first use", () => {
  test("follows the release redirect, verifies both files, and later finds them without the network", async () => {
    reset();
    const root = await fresh();
    const progress: number[] = [];
    const dir = await ensureWorkModel(root, { manifest: manifest(), freeBytes: PLENTY, onProgress: (p) => p.file === "model.onnx" && progress.push(p.received) });
    expect(dir).toBe(modelDirectory(root, manifest()));
    expect(new Uint8Array(await readFile(join(dir, "model.onnx")))).toEqual(MODEL);
    expect(hits.map((h) => h.path)).toEqual(["/release/tokenizer.json", "/assets/tokenizer.json", "/release/model.onnx", "/assets/model.onnx"]);
    expect(progress.at(-1)).toBe(MODEL.length);
    hits = [];
    expect(await ensureWorkModel(root, { manifest: manifest(), freeBytes: PLENTY })).toBe(dir);
    expect(hits).toEqual([]);
  });

  test("resumes a broken download with a byte range, and verifies the whole file", async () => {
    reset();
    const root = await fresh();
    const dir = modelDirectory(root, manifest());
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "model.onnx.partial"), MODEL.slice(0, 120_000));
    await ensureWorkModel(root, { manifest: manifest(), freeBytes: PLENTY });
    expect(hits.find((h) => h.path === "/assets/model.onnx")?.range).toBe("bytes=120000-");
    expect(sha(new Uint8Array(await readFile(join(dir, "model.onnx"))))).toBe(sha(MODEL));
    expect(existsSync(join(dir, "model.onnx.partial"))).toBe(false);
  });

  test("starts again when the host ignores the range", async () => {
    reset();
    ignoreRanges = true;
    const root = await fresh();
    const dir = modelDirectory(root, manifest());
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "model.onnx.partial"), MODEL.slice(0, 50_000));
    await ensureWorkModel(root, { manifest: manifest(), freeBytes: PLENTY });
    expect(sha(new Uint8Array(await readFile(join(dir, "model.onnx"))))).toBe(sha(MODEL));
  });

  test("refuses bytes that do not match, and keeps nothing of them", async () => {
    reset();
    corrupt = true;
    const root = await fresh();
    await expect(ensureWorkModel(root, { manifest: manifest(), freeBytes: PLENTY })).rejects.toThrow(/does not match the pinned SHA-256/);
    const dir = modelDirectory(root, manifest());
    expect(await readdir(dir)).toEqual(["tokenizer.json"]);
  });

  test("refuses to start without enough space, and removes other revisions once ready", async () => {
    reset();
    const root = await fresh();
    await expect(ensureWorkModel(root, { manifest: manifest(), freeBytes: () => 10 * 1024 * 1024 })).rejects.toThrow(/only 10 MB free/);
    expect(hits).toEqual([]);
    await mkdir(join(root, "rev1"), { recursive: true });
    await writeFile(join(root, "rev1", "model.onnx"), "old");
    await ensureWorkModel(root, { manifest: manifest(), freeBytes: PLENTY });
    expect(await readdir(root)).toEqual(["rev2"]);
  });

  test("the fetcher downloads once, reports its state, and waits before retrying a failure", async () => {
    reset();
    corrupt = true;
    let now = 1_000;
    const states: string[] = [];
    const fetcher = new WorkModelFetcher(await fresh(), { manifest: manifest(), freeBytes: PLENTY, now: () => now });
    fetcher.onChange((s) => states.at(-1) !== s.state && states.push(s.state));
    expect(fetcher.state()).toEqual({ state: "absent" });
    const [a, b] = await Promise.all([fetcher.request(), fetcher.request()]);
    expect([a, b]).toEqual([null, null]);
    expect(hits.filter((h) => h.path === "/assets/model.onnx")).toHaveLength(1);
    expect(fetcher.state()).toMatchObject({ state: "failed", retryAt: 61_000 });
    hits = [];
    corrupt = false;
    expect(await fetcher.request()).toBeNull();
    expect(hits).toEqual([]);
    now = 61_000;
    const dir = await fetcher.request();
    expect(dir).not.toBeNull();
    expect(fetcher.state()).toEqual({ state: "ready", directory: dir! });
    expect(states).toEqual(["downloading", "failed", "downloading", "ready"]);
  });
});
