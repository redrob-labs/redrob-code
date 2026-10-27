export * from "./client.js"
export * from "./server.js"
export * from "../daemon.js"
// The generated types now carry these too; the daemon client's own shapes win.
export type { BridgedApp, BridgedAppList } from "../daemon.js"

import { createRedrobClient } from "./client.js"
import { createRedrobServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export * as data from "./data.js"

export async function createRedrob(options?: ServerOptions) {
  const server = await createRedrobServer({
    ...options,
  })

  const client = createRedrobClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
