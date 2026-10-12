import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", node: "src/node.ts", wordpiece: "src/wordpiece.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  target: "es2022",
  platform: "neutral",
  sourcemap: false,
  splitting: true,
  treeshake: true,
  external: ["onnxruntime-node", "onnxruntime-web", "node:fs", "node:fs/promises", "node:path"],
  loader: { ".json": "json" },
});
