// The work classifier in a browser: @redrob-labs/work-labeller's runtime-neutral entry + onnxruntime-web.
import * as ort from "onnxruntime-web/wasm"
import { createWorkClassifier } from "../../src/index"

type Ref = { text: string; action: string | null; family: string | null; confidence: number }

declare global {
  interface Window {
    runSpike: (threads: number) => Promise<unknown>
  }
}

window.runSpike = async (threads: number) => {
  ort.env.wasm.wasmPaths = "/ort/"
  ort.env.wasm.numThreads = threads
  const bytes = async (path: string) => new Uint8Array(await (await fetch(path)).arrayBuffer())
  const t0 = performance.now()
  const [model, tokenizer] = await Promise.all([bytes("/model/model_int8.onnx"), bytes("/model/tokenizer.json")])
  const fetched = performance.now()
  const classifier = await createWorkClassifier({ model, tokenizer }, ort, { threads })
  const loaded = performance.now()
  const ref: Ref[] = await (await fetch("/ref.json")).json()
  const labels: { action: string | null; family: string | null }[] = []
  let agree = 0
  let maxDiff = 0
  const times: number[] = []
  for (const r of ref) {
    const s = performance.now()
    const got = await classifier.label(r.text)
    labels.push({ action: got.action, family: got.family })
    times.push(performance.now() - s)
    if (got.action === r.action && got.family === r.family) agree += 1
    maxDiff = Math.max(maxDiff, Math.abs(got.confidence - r.confidence))
  }
  times.sort((a, b) => a - b)
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  return {
    userAgent: navigator.userAgent,
    threads,
    crossOriginIsolated: self.crossOriginIsolated,
    fetchMs: Math.round(fetched - t0),
    loadMs: Math.round(loaded - fetched),
    samples: ref.length,
    agree,
    maxConfidenceDiff: maxDiff,
    medianMs: +times[times.length >> 1]!.toFixed(1),
    p95Ms: +times[Math.floor(times.length * 0.95)]!.toFixed(1),
    labels,
    jsHeapMB: memory ? Math.round(memory.usedJSHeapSize / 1e6) : null,
  }
}
