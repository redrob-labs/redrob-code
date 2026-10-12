// End-to-end: the PACKAGED desktop app runs a whole blind build-off through its own bridge and its
// bundled engine, against scripted vendors (no key, no network), driven by Playwright.
//
//   bun run package --dir && xvfb-run node e2e/buildoff.mjs
//
// E2E_ROOT holds the scratch data; E2E_SHOTS receives screenshots.
import { _electron as electron } from "playwright-core"
import { spawn } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = process.env.E2E_ROOT ?? path.join(tmpdir(), "redrob-code-e2e")
const home = path.join(root, "home-buildoff")
rmSync(home, { recursive: true, force: true })
rmSync(path.join(root, "work"), { recursive: true, force: true })
mkdirSync(path.join(root, "work"), { recursive: true })
const shots = process.env.E2E_SHOTS ?? path.join(root, "screenshots")
mkdirSync(shots, { recursive: true })

const vendors = spawn(process.env.BUN ?? "bun", ["run", path.join(here, "vendors.ts"), path.join(root, "work")], {
  stdio: ["ignore", "pipe", "inherit"],
})
const repo = await new Promise((resolve) => {
  vendors.stdout.on("data", (chunk) => {
    const match = /READY (\S+)/.exec(String(chunk))
    if (match) resolve(match[1])
  })
})

const userData = path.join(home, ".config", "Redrob Code")
mkdirSync(userData, { recursive: true })
writeFileSync(
  path.join(userData, "redrob-code-settings.json"),
  JSON.stringify({ theme: "dark", recentProjects: [repo], consent: { decided: true } }),
)

const results = []
const step = (name, ok, detail = "") => {
  results.push(ok)
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
}

const app = await electron.launch({
  executablePath: path.join(here, "..", "dist", "linux-unpacked", "redrob-code-desktop"),
  args: ["--no-sandbox", "--disable-gpu"],
  env: {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    REDROB_DISABLE_MODELS_FETCH: "1",
  },
  timeout: 60_000,
})
const page = await app.firstWindow()
await page.setViewportSize({ width: 1400, height: 900 })
page.on("pageerror", (error) => console.log(`PAGEERROR ${error.message}`))
const shot = (name) => page.screenshot({ path: path.join(shots, `buildoff-${name}.png`), fullPage: true })

try {
  await page.getByRole("button", { name: "Continue without signing in" }).click({ timeout: 45_000 })
  await page.getByRole("tab", { name: "Build-off" }).waitFor({ timeout: 15_000 })
  step(
    "the build-off is the first tab of a project",
    (await page.getByRole("tab", { name: "Build-off" }).getAttribute("aria-selected")) === "true",
  )
  await page
    .getByPlaceholder("Describe the change, or paste an issue…")
    .fill("Add a `sub(a, b)` function to src/math.ts that returns a minus b.")
  await shot("1-task")
  await page.getByRole("button", { name: "Start build-off" }).click()
  await page.getByText("Candidate A").first().waitFor({ timeout: 30_000 })
  await shot("2-running")
  step("lanes appear while builders work", true)

  await page.getByText("Meets your standard").waitFor({ timeout: 240_000 })
  step("the verdict holds the winner to the standard", true)
  const body = await page.locator("body").innerText()
  step("no model name is shown before choosing", !/acme|beta\/|gamma|delta|eps\//i.test(body))
  step("gates are shown", body.includes("Correctness") && body.includes("Quality") && body.includes("Consensus"))
  step("the who-beat-whom matrix is shown", body.includes("Who beat whom"))
  await shot("3-verdict")

  const recommended = page.getByRole("button", { name: /^Choose [A-C]$/ }).first()
  const label = await recommended.innerText()
  await page.getByRole("button", { name: label }).click()
  await page.getByText("Create a branch").waitFor({ timeout: 15_000 })
  const revealed = await page.locator("body").innerText()
  step("names are revealed only after choosing", /acme\/coder/.test(revealed), label)
  step(
    "the judges' choice was the correct candidate",
    new RegExp(`${label.replace("Choose ", "Candidate ")} · acme/coder`).test(revealed),
  )
  await shot("4-revealed")
  await page.getByRole("button", { name: "Create a branch" }).click()
  await page.getByText(/Created branch redrob\/contest-/).waitFor({ timeout: 15_000 })
  step("applying creates a branch", true)
  await shot("5-applied")

  const { execFileSync } = await import("node:child_process")
  const branch = execFileSync("git", ["branch", "--list", "redrob/contest-*", "--format=%(refname:short)"], {
    cwd: repo,
    encoding: "utf8",
  }).trim()
  const message = execFileSync("git", ["log", "-1", "--format=%B", branch], { cwd: repo, encoding: "utf8" })
  step(
    "the commit records which model wrote it",
    message.includes("Redrob-Provider: acme") && message.includes("Redrob-Model: coder"),
    branch,
  )
} catch (error) {
  step("unexpected failure", false, error instanceof Error ? error.message.split("\n")[0] : String(error))
  await shot("error").catch(() => {})
} finally {
  await app.close()
  vendors.kill()
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`)
process.exit(results.every(Boolean) ? 0 : 1)
