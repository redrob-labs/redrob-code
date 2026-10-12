# Work classifier in a webview: measurement (Design, PR 4 of office-and-design.md)

Runs the package's runtime-neutral classifier on `onnxruntime-web` (WASM) in a browser engine, against the 296 evaluation samples, and reports agreement with the Python/onnxruntime-node reference, latency, load time and heap.

```sh
npm i onnxruntime-web@1.23.0 zod@4
bun build spike.ts --target=browser --outfile www/spike.js
echo '<!doctype html><meta charset="utf-8"><script type="module" src="/spike.js"></script>' > www/index.html
# www/ref.json: [{ text, action, family, confidence }] for the 296 evaluation samples, from the Python reference
PLAYWRIGHT_FROM=/path/to/package.json BROWSER=chromium CHROME=/usr/local/bin/chrome node run.mjs
```

The page is served cross-origin isolated (COOP/COEP), which WASM threads need. Results are in `docs/features/ai-work-insights/office-and-design.md`.
