export * from "./client.js"
export * from "./server.js"

import { createRedrobClient } from "./client.js"
import { createRedrobServer } from "./server.js"
import type { ServerOptions } from "./server.js"

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
