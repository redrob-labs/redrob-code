#!/usr/bin/env bun
// Stands in for `redrob serve`: checks the credential the manager passes, answers the two health
// routes, and prints the same handshake line. `FAKE_ENGINE_CRASH_AFTER_MS` makes it exit on its own.
const user = process.env["REDROB_SERVER_USERNAME"]
const pass = process.env["REDROB_SERVER_PASSWORD"]
const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (request.headers.get("authorization") !== expected) return new Response("no", { status: 401 })
    const url = new URL(request.url)
    if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "9.9.9" })
    if (url.pathname === "/api/health") return Response.json({ healthy: true })
    return new Response("missing", { status: 404 })
  },
})

console.log(`client=${process.env["REDROB_CLIENT"]} autoupdate=${process.env["REDROB_DISABLE_AUTOUPDATE"] ?? ""}`)
console.log(`redrob server listening on http://127.0.0.1:${server.port}`)

const crash = Number(process.env["FAKE_ENGINE_CRASH_AFTER_MS"] ?? 0)
if (crash > 0) setTimeout(() => process.exit(3), crash)
