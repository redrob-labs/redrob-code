// Starts the scripted vendors and a fixture repo for the desktop build-off end-to-end run, prints
// `READY <repo>` and stays up until killed.
import path from "node:path"
import { createRepo, scriptedVendors } from "../../../packages/contest/test/fixture/repo"

const llm = scriptedVendors()
const repo = path.join(process.argv[2]!, "demo-repo")
createRepo(repo, llm)
console.log(`READY ${repo}`)
setInterval(() => {}, 60_000)
