import path from "node:path"
import { pathToFileURL } from "node:url"

/**
 * The interface is served from `oc://renderer/`, not `file://`.
 *
 * A page loaded from `file://` sends `Origin: null`, which the engine's CORS rules refuse
 * (packages/server/src/cors.ts). `oc://renderer` is already on that allowlist for exactly this reason,
 * so serving the bundle under it needs no `--cors` flag and no change to the engine.
 */

export const RENDERER_SCHEME = "oc"
export const RENDERER_HOST = "renderer"
export const RENDERER_URL = `${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`

/**
 * The file a request maps to, or null when it would leave the bundle directory. Unknown paths fall
 * back to index.html, so a reload on any in-app route still loads the app.
 */
export function resolveRendererFile(root: string, requestUrl: string, exists: (file: string) => boolean) {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${RENDERER_SCHEME}:` || url.host !== RENDERER_HOST) return null
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html"
  const resolvedRoot = path.resolve(root)
  const file = path.resolve(resolvedRoot, relative)
  if (file !== resolvedRoot && !file.startsWith(resolvedRoot + path.sep)) return null
  if (exists(file)) return pathToFileURL(file).toString()
  return pathToFileURL(path.join(resolvedRoot, "index.html")).toString()
}
