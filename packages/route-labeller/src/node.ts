/*
 * Node-side helpers: reading the route model from a directory, and putting it there.
 *
 * Separate from the runtime-neutral core (index.ts) because it touches the filesystem and the
 * network. redrob-server, Office's main process and the build scripts that package the model use
 * this; Design's webview uses the core with bytes it fetched itself.
 *
 * The weights are not in git (about 140 MB). Each file is fetched from the pinned Hugging Face
 * revision the manifest names, and kept only when it hashes to the manifest's SHA-256, so a
 * download is never trusted for what it claims to be.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { SentenceEncoder, sha256Hex } from "./encoder.js";
import { RouteLabeller } from "./labeller.js";
import { LEXICON, MANIFEST, PROTOTYPES } from "./index.js";
import type { OrtRuntime, RouteModelManifest } from "./types.js";

export * from "./index.js";

function pinned(manifest: RouteModelManifest) {
  return [manifest.model, manifest.tokenizer, manifest.dense];
}

/** Whether every pinned file is in `directory` and matches. */
export async function routeModelPresent(directory: string, manifest: RouteModelManifest = MANIFEST): Promise<boolean> {
  for (const entry of pinned(manifest)) {
    const path = join(directory, entry.file);
    if (!existsSync(path)) return false;
    if ((await sha256Hex(new Uint8Array(await readFile(path)))) !== entry.sha256) return false;
  }
  return true;
}

/**
 * Makes every pinned file present and verified in `directory`, downloading what is missing from the
 * manifest's own URLs, or copying it from `source` when given. Writes the manifest beside them.
 */
export async function prepareRouteModel(
  directory: string,
  options: {
    manifest?: RouteModelManifest;
    source?: string | null;
    fetchImpl?: typeof fetch;
    log?: (line: string) => void;
  } = {},
): Promise<void> {
  const manifest = options.manifest ?? MANIFEST;
  const log = options.log ?? (() => undefined);
  await mkdir(directory, { recursive: true });
  for (const entry of pinned(manifest)) {
    const target = join(directory, entry.file);
    if (existsSync(target) && (await sha256Hex(new Uint8Array(await readFile(target)))) === entry.sha256) continue;
    let bytes: Uint8Array;
    if (options.source) {
      bytes = new Uint8Array(await readFile(join(options.source, entry.file)));
    } else {
      if (!entry.url) throw new Error(`route model manifest has no URL for ${entry.file}`);
      log(`downloading ${entry.url}`);
      const response = await (options.fetchImpl ?? fetch)(entry.url);
      if (!response.ok) throw new Error(`${entry.url} answered ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    const actual = await sha256Hex(bytes);
    if (actual !== entry.sha256) {
      throw new Error(`${entry.file} does not match the pinned SHA-256 (expected ${entry.sha256}, got ${actual})`);
    }
    await writeFile(`${target}.partial`, bytes);
    await rename(`${target}.partial`, target);
  }
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(directory, "NOTICE.md"), MODEL_NOTICE);
}

/** Shipped beside the weights, because the Apache License asks for its notice to travel with them. */
const MODEL_NOTICE = `# Route model

sentence-transformers/distiluse-base-multilingual-cased-v2 (Dense projection) and the int8 ONNX export and
tokenizer of Xenova/distiluse-base-multilingual-cased-v2, licensed under the Apache License 2.0
(https://www.apache.org/licenses/LICENSE-2.0). Unmodified; each file is pinned by SHA-256 in manifest.json.
`;

/**
 * The labeller, with the embedding pass when the model is in `directory` and the lexical pass alone
 * when it is not. Never throws for a missing or tampered model: routing still works on words, and
 * `labeller.mode` says which it is.
 */
export async function loadRouteLabeller(options: {
  directory?: string | null;
  loadRuntime?: () => Promise<OrtRuntime>;
  threads?: number;
}): Promise<{ labeller: RouteLabeller; reason: string | null }> {
  const lexical = new RouteLabeller(LEXICON, null, null);
  if (!options.directory) return { labeller: lexical, reason: "no route model is installed" };
  try {
    const read = (file: string) => readFile(join(options.directory!, file)).then((buffer) => new Uint8Array(buffer));
    const [model, tokenizer, dense] = await Promise.all([
      read(MANIFEST.model.file),
      read(MANIFEST.tokenizer.file),
      read(MANIFEST.dense.file),
    ]);
    const ort = await (options.loadRuntime ??
      (async () => (await import("onnxruntime-node")) as unknown as OrtRuntime))();
    const encoder = await SentenceEncoder.load({ manifest: MANIFEST, model, tokenizer, dense }, ort, {
      threads: options.threads,
    });
    return { labeller: new RouteLabeller(LEXICON, PROTOTYPES, encoder), reason: null };
  } catch (error) {
    return { labeller: lexical, reason: error instanceof Error ? error.message : String(error) };
  }
}
