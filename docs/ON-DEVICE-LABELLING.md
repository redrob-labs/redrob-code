# On-device labelling: the encoders, the tensors, and compatibility

Two packages in this repo label a request on the person's own machine so that only
the labels — never the message text — leave it: `@redrob-labs/route-labeller`
(profession × task, for how Redrob Auto routes) and `@redrob-labs/work-labeller`
(kind of work, mode and outcome, for the Console's insights). Redrob Cowork, Office
and Design all consume them, so a request labels the same way in every product.

This document is the design of record for *why* that code exists in the shape it does,
*where* the model data lives, how it is tested, and how older or third-party clients
stay compatible. It is the one place to send someone asking "why did we build our own
encoders".

## 1. Why there is encoder code at all (we did not train encoders)

We did **not** build sentence encoders from scratch. `encoder.ts` (route-labeller)
and `classifier.ts` (work-labeller) are a few hundred lines of glue around
**pinned, off-the-shelf open-source models**:

| Package | Base model (not ours) | What our code is |
| --- | --- | --- |
| route-labeller | `sentence-transformers/distiluse-base-multilingual-cased-v2`, int8 ONNX | tokenize → run the ONNX transformer on `onnxruntime` → mean-pool over the attention mask → the model's own 768→512 Dense+tanh projection |
| work-labeller | `Xenova/multilingual-e5-base`, int8 ONNX | the same pipeline shape, feeding two small trained heads |

There is encoder *code* — rather than a call to a hosted embeddings API — for three
reasons, in priority order:

1. **Privacy is the feature.** The whole point is that classification happens on the
   user's device and only the resulting labels are sent. A hosted embeddings API would
   require sending the text off the machine, which defeats it.
2. **One implementation, three runtimes.** The encoder is runtime-neutral (bytes in,
   no filesystem, no `node:crypto`; integrity uses WebCrypto). The *same* code runs in
   `redrob-server` (Node), Office's Electron main process, and Design's webview, so a
   request labels **identically** everywhere. Three separate integrations could not
   guarantee that.
3. **Cross-language coverage for free.** distiluse was chosen specifically because it
   reuses the exact BERT WordPiece tokenizer the privacy detector already ships (no
   second tokenizer to maintain) and because it maps a sentence and its translation
   close together across ~50 languages — which is what lets **one** set of prototype
   sentences cover English, Korean and Hindi, the three ModelGuide languages.

So: our code, borrowed models.

## 2. Where the fine-tuned tensors live

Only the small, task-specific layers are ours. They are **committed to git**. The
large base encoders are **not** in git — they are downloaded at a pinned revision and
verified by SHA-256.

| Tier | What | Where it is now | Size |
| --- | --- | --- | --- |
| **Ours (trained)** | work-labeller's two classifier heads (`WORK_HEAD`) | `packages/work-labeller/src/work-head.json` (in git) | ~159 KB |
| **Ours (trained)** | route-labeller's per-cell prototype vectors (`PROTOTYPES`) | `packages/route-labeller/src/prototypes.json` (in git) | ~232 KB |
| Off-the-shelf | distiluse int8 ONNX | downloaded from Hugging Face, pinned revision + SHA | ~140 MB |
| Off-the-shelf | multilingual-e5-base int8 ONNX | downloaded from a GitHub **release asset**, pinned revision + SHA | ~278 MB |

The "router" is not a neural net: routing is `prototypes.json` (one prototype
sentence per profession × task) plus a lexical word table — both tiny text files in
git. Nothing proprietary is a multi-hundred-MB blob.

### Pending: move the e5 release asset to this repo

`packages/work-labeller/src/manifest.json` currently points the e5 model and tokenizer
URLs at a **`redrob-labs/redrob-cowork`** release (`insights-model-e5-base-2026.10`).
Since redrob-code is now the single source of truth and publisher for these packages,
that asset should be re-hosted here and the two `url` fields updated. **The SHA-256
pins do not change** — they are the real integrity guarantee; the URL is only where to
fetch from. Checklist:

1. Upload `model_int8.onnx` and `tokenizer.json` (byte-identical to the pinned SHAs) as
   a redrob-code release, e.g. `insights-model-e5-base-2026.10`.
2. Update the two `url` fields in `manifest.json` to the redrob-code release.
3. Leave `revision` and both `sha256` values unchanged; a mirrored asset that does not
   match the pins is rejected by the downloader, which is the point.

Until that asset exists, the manifest keeps the working cowork URL — pointing it at a
not-yet-uploaded redrob-code release would 404 every download.

## 3. Tests, and the CI story

The unit suites are **model-free and CI-safe** — they do not need the real multi-hundred-MB
models, which is why `labellers (linux)` runs green in CI with nothing downloaded:

- `work-labeller/test/classifier.test.ts` uses a stub ONNX runtime (`fakeOrt`) and a
  synthetic tokenizer; it writes tiny temp fixtures with `mkdtemp`.
- `work-labeller/test/download.test.ts` stands up a local `Bun.serve` fake release host
  and a 300 KB synthetic model to exercise resume / hashing / retry — no network, no
  real file.
- The `model/` tests check **training-data invariants** (coverage, no train/eval
  leakage, label validity) against the committed JSON — not model tensors.
- route-labeller ships **no unit suite**; its accuracy check is the `eval/` held-out
  script, run by hand.

What genuinely needs the real model is the **opt-in developer path**, and that is
deliberately out of CI (a 278 MB download per run is not worth gating PRs on):

- `pnpm model` fetches and verifies the real model into a local folder.
- `pnpm eval` (route-labeller) reports top-1 / top-3 on the held-out set.

If accuracy-in-CI is ever wanted, add a **manual / scheduled** workflow that restores a
**cached** model artifact and runs `eval` — never on the PR path.

## 4. Backwards compatibility, including third-party model APIs

A stock OpenAI/Anthropic SDK, or an older client, knows nothing about `redrob.route`,
`x-redrob-session`, or the `/redrob/*` endpoints. It keeps working, by three
mechanisms (see `docs/LOCAL-ENGINE-API.md` for the engine contract):

1. **Additive, path-versioned contract.** The contract is versioned by URL (`/v1/...`),
   never by engine version. **Unknown request fields are ignored, not rejected**, so a
   stock client posting to `/v1/chat/completions` works unchanged and our
   `redrob.route` rides along as an ignored extra for anyone who does not set it.
   Removing or redefining a field requires `/v2`, and `/v1` is served for two minor
   versions after. A contract test pins the v1 request/response shape and fails CI if a
   field is dropped (see `packages/redrob/test/server/httpapi-chat-completion.test.ts`).
2. **Graceful degradation of the labeller.** With no model present the labeller still
   answers by words alone and marks `labeller.mode = "lexical"`. The Console routes on
   the ModelGuide only for `"embedding"` labels; **lexical labels, and requests with no
   label at all, fall back to the legacy task-type table** — they route the old way
   rather than failing.
3. **"Preference, not override" semantics.** Even the routing hints are lenient: an
   unknown or ineligible model id falls back to the table rather than failing the
   request.

The net: our additions are opt-in extras layered on an OpenAI-compatible surface, so a
third-party client that knows none of them is unaffected.
