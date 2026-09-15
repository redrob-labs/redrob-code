import { defineConfig } from "drizzle-kit"

import os from "node:os"
import path from "node:path"

// drizzle-kit needs a concrete database file to diff the schema against. This was
// hardcoded to one developer's home directory, so `drizzle-kit generate` only worked
// on their machine and silently wrote migrations against nothing on anyone else's.
// Resolved the same way the application resolves it, with an override for a checkout
// that keeps its data elsewhere.
const dataHome = process.env["XDG_DATA_HOME"] || path.join(os.homedir(), ".local", "share")
const databaseUrl = process.env["REDROB_DB"] || path.join(dataHome, "redrob", "redrob.db")

export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/**/*.sql.ts", "./src/**/sql.ts"],
  out: "./migration",
  dbCredentials: {
    url: databaseUrl,
  },
})
