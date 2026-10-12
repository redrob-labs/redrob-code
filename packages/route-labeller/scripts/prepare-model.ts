/*
 * Fetches the route model into a directory, verified against the pinned manifest.
 *
 *   pnpm --filter @redrob-labs/route-labeller model [directory]
 *
 * Defaults to .route-model/ beside this package, which is where the prototype and evaluation
 * scripts read it from. REDROB_ROUTE_MODEL_SOURCE copies from a local folder instead.
 */
import { join } from "node:path";

import { prepareRouteModel } from "../src/node.ts";

const directory = process.argv[2] ?? join(import.meta.dir, "..", ".route-model");
await prepareRouteModel(directory, {
  source: process.env.REDROB_ROUTE_MODEL_SOURCE?.trim() || null,
  log: (line) => console.error(`[route-model] ${line}`),
});
console.log(`route model ready in ${directory}`);
