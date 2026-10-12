# @redrob-labs/route-labeller

Labels a request with its ModelGuide profession and task on the person's machine, for Redrob Auto to route on.

## What it is

Redrob Auto routes on the ModelGuide: profession x task x working language, the guide's ranked picks at their ranked effort. This package says which profession and task a request is, locally, and the app sends the result to Console as `redrob.route`. Only the two ids and the runners-up leave the machine. Redrob Cowork, Office and Design all use it, so a request labels the same way in each.

Without its model the labeller still answers, by words alone, and says so with `labeller.mode = "lexical"`. Console routes Redrob Auto on the ModelGuide only for `"embedding"` labels; lexical ones, and requests with no label at all, route on the legacy task-type table.

Two passes, combined: a multilingual sentence encoder (distiluse-base-multilingual-cased-v2, int8 ONNX, run with onnxruntime) compared against one prototype per cell, and the lexical pass Console itself runs on an unlabelled request. Without the model it runs the lexical pass alone.

On the held-out set in `eval/` (132 sentences, en/ko/hi): 84.8% top-1 and 96.2% top-3 with the encoder, 59.8% / 68.2% on words alone. Console tries the runners-up in order, so top-3 is the number that bounds a wrong route.

## Getting started

```ts
import { loadRouteLabeller, prepareRouteModel, routeBody } from "@redrob-labs/route-labeller/node";

await prepareRouteModel("./route-model");                    // fetched and verified once
const { labeller } = await loadRouteLabeller({ directory: "./route-model" });
const label = await labeller.label("이 계약서의 불리한 조항을 검토해줘");
// { profession: "lawyer", task: "review", edition: "2026-10-06",
//   labeller: { id: "route-labeller/embedding", mode: "embedding", ... }, candidates: [...] }

await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers,
  body: JSON.stringify({ model: "auto", messages, ...routeBody(label) }),
});
```

In a browser or webview, use the runtime-neutral entry with `onnxruntime-web` and bytes you fetched: `SentenceEncoder.load({ manifest: MANIFEST, model, tokenizer, dense }, ort)`, then `new RouteLabeller(LEXICON, PROTOTYPES, encoder)`.

`guideProfessions(edition, locale)` turns Console's `GET /v1/guide` into the props of the ModelGuide component in `@redrob-labs/ui`.

## Development

| Command | What it does |
| --- | --- |
| `pnpm model` | Fetches the model into `.route-model/`, verified against `src/manifest.json` |
| `pnpm prototypes` | Rebuilds `src/prototypes.json` after the lexicon changes |
| `pnpm eval` | Top-1 / top-3 on `eval/held-out.json`, per language, both passes |
| `pnpm typecheck`, `pnpm build` | Types; the ESM build in `dist/` |

`src/lexicon.json` is the source of the words. Console's `guide:sync` copies it into each ModelGuide edition, so change it here, rebuild the prototypes, and re-sync Console.

## License

MIT. The model is sentence-transformers/distiluse-base-multilingual-cased-v2 (Apache-2.0), see `NOTICE.md`.
