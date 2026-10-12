import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Relative asset URLs, because the packaged app serves this bundle from oc://renderer/ rather than a
// web server root.
export default defineConfig({
  base: "./",
  plugins: [react()],
  // Loaded from disk inside the app, never over a network, so one large chunk costs nothing.
  build: { outDir: "dist", emptyOutDir: true, target: "chrome130", sourcemap: true, chunkSizeWarningLimit: 4096 },
  server: { strictPort: true },
})
