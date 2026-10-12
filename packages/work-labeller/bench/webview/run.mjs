// Serves the spike (cross-origin isolated, so wasm threads are allowed) and drives it in a browser engine.
// Before running: `npm i onnxruntime-web@1.23.0 zod@4` here, `bun build spike.ts --target=browser --outfile
// www/spike.js`, write www/index.html loading /spike.js, and www/ref.json (the Python reference labels,
// [{ text, action, family, confidence }], from the 296 evaluation samples). See README.md.
import { createReadStream, statSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { extname, join } from "node:path"

// PLAYWRIGHT_FROM: a package.json whose node_modules has playwright-core. BROWSER: chromium or webkit.
// CHROME: a Chrome binary for chromium (optional). MODEL_DIR: a folder holding the pinned model files.
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? import.meta.url)
const engines = require("playwright-core")
const kind = process.env.BROWSER ?? "chromium"
const here = new URL(".", import.meta.url).pathname

const roots = {
  "/ort/": join(here, "node_modules/onnxruntime-web/dist/"),
  "/model/": process.env.MODEL_DIR ?? join(here, "../../../../apps/desktop/resources/insights-model/"),
  "/": join(here, "www/"),
}
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" }
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x")
  const prefix = Object.keys(roots).find((p) => url.pathname.startsWith(p))
  const file = join(roots[prefix], url.pathname.slice(prefix.length) || "index.html")
  try {
    statSync(file)
  } catch {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, {
    "content-type": types[extname(file)] ?? "application/octet-stream",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
  })
  createReadStream(file).pipe(res)
})
await new Promise((resolve) => server.listen(18931, "127.0.0.1", resolve))

const browser = await engines[kind].launch(
  kind === "chromium" ? { ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox", "--enable-precise-memory-info"] } : {},
)
for (const threads of [1, 2, 4]) {
  const page = await browser.newPage()
  page.on("pageerror", (e) => console.log("pageerror", e.message))
  await page.goto("http://127.0.0.1:18931/")
  await page.waitForFunction(() => typeof window.runSpike === "function")
  const result = await page.evaluate((t) => window.runSpike(t), threads)
  delete result.labels
  delete result.userAgent
  console.log(JSON.stringify(result))
  await page.close()
}
await browser.close()
server.close()
