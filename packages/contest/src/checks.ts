import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { shell, tail } from "./proc"

/**
 * The repository's own checks, found from its files, and how to run a single test file.
 *
 * Nothing here is configured per repo by default: `package.json` scripts, `pyproject.toml`, `Cargo.toml`
 * and `go.mod` say what a project checks itself with. `.redrob/contest.json` overrides any of it:
 *
 *   { "setup": ["pnpm install --frozen-lockfile"], "checks": [{ "name": "test", "command": "pnpm test" }] }
 */

export type Check = { name: string; command: string }
export type Project = {
  setup: string[]
  checks: Check[]
  /** Builds the command that runs only the given test files, or null when the runner is unknown. */
  testFiles: ((files: string[]) => string) | null
  runner: string | null
}

type Override = { setup?: string[]; checks?: Check[]; test?: string }

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

const quote = (file: string) => (/^[\w./-]+$/.test(file) ? file : JSON.stringify(file))

export function detectProject(directory: string): Project {
  const has = (file: string) => existsSync(path.join(directory, file))
  const override = (readJson(path.join(directory, ".redrob", "contest.json")) ?? {}) as Override
  const setup: string[] = []
  const checks: Check[] = []
  let testFiles: Project["testFiles"] = null
  let runner: string | null = null

  if (has("package.json")) {
    const pkg = (readJson(path.join(directory, "package.json")) ?? {}) as {
      scripts?: Record<string, string>
      devDependencies?: Record<string, string>
      dependencies?: Record<string, string>
    }
    // The lockfile decides; without one, the `packageManager` field does; otherwise npm.
    const declared = /^(bun|pnpm|yarn|npm)@/.exec((pkg as { packageManager?: string }).packageManager ?? "")?.[1] as
      | "bun"
      | "pnpm"
      | "yarn"
      | "npm"
      | undefined
    const pm =
      has("bun.lock") || has("bun.lockb")
        ? "bun"
        : has("pnpm-lock.yaml")
          ? "pnpm"
          : has("yarn.lock")
            ? "yarn"
            : has("package-lock.json")
              ? "npm"
              : (declared ?? "npm")
    const install = {
      bun: "bun install --frozen-lockfile",
      pnpm: "pnpm install --frozen-lockfile",
      yarn: "yarn install --frozen-lockfile",
      npm: has("package-lock.json") ? "npm ci" : "npm install",
    }[pm]
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    if (Object.keys(deps).length > 0) setup.push(install)
    const scripts = pkg.scripts ?? {}
    const runScript = (name: string) => (pm === "npm" ? `npm run ${name}` : `${pm} run ${name}`)
    for (const name of ["typecheck", "lint", "test"]) {
      if (scripts[name] && !/no test specified/.test(scripts[name]!)) checks.push({ name, command: runScript(name) })
    }
    const testScript = scripts["test"] ?? ""
    const exec = pm === "bun" ? "bunx" : pm === "pnpm" ? "pnpm exec" : pm === "yarn" ? "yarn" : "npx"
    if (/\bvitest\b/.test(testScript) || deps["vitest"]) {
      runner = "vitest"
      testFiles = (files) => `${exec} vitest run ${files.map(quote).join(" ")}`
    } else if (/\bjest\b/.test(testScript) || deps["jest"]) {
      runner = "jest"
      testFiles = (files) => `${exec} jest ${files.map(quote).join(" ")}`
    } else if (/\bbun test\b/.test(testScript) || pm === "bun") {
      runner = "bun"
      testFiles = (files) =>
        `bun test ${files.map((file) => quote(file.startsWith(".") ? file : `./${file}`)).join(" ")}`
    } else if (/node --test/.test(testScript)) {
      runner = "node"
      testFiles = (files) => `node --test ${files.map(quote).join(" ")}`
    }
  } else if (has("pyproject.toml") || has("setup.py") || has("pytest.ini")) {
    if (has("uv.lock")) setup.push("uv sync")
    const python = has("uv.lock") ? "uv run" : "python -m"
    checks.push({ name: "test", command: `${python} pytest -q` })
    runner = "pytest"
    testFiles = (files) => `${python} pytest -q ${files.map(quote).join(" ")}`
  } else if (has("Cargo.toml")) {
    checks.push({ name: "check", command: "cargo check --quiet" }, { name: "test", command: "cargo test --quiet" })
    runner = "cargo"
  } else if (has("go.mod")) {
    checks.push({ name: "vet", command: "go vet ./..." }, { name: "test", command: "go test ./..." })
    runner = "go"
    testFiles = (files) =>
      `go test ${[...new Set(files.map((file) => `./${path.posix.dirname(file.replaceAll("\\", "/"))}`))].join(" ")}`
  }

  return {
    setup: override.setup ?? setup,
    checks: override.checks ?? checks,
    testFiles: override.test ? (files) => `${override.test} ${files.map(quote).join(" ")}` : testFiles,
    runner: override.test ? "custom" : runner,
  }
}

export type CheckResult = {
  name: string
  passed: boolean
  warnings: number
  durationMs: number
  output: string
  timedOut: boolean
}

/** Lines that look like a warning in common tool output. Counted, not parsed: only the change matters. */
export function countWarnings(output: string) {
  return output.split(/\r?\n/).filter((line) => /\bwarn(ing)?\b|⚠/i.test(line) && !/\b0 warnings?\b/i.test(line))
    .length
}

export async function runSetup(directory: string, project: Project, timeoutMs: number) {
  for (const command of project.setup) {
    const result = await shell(command, directory, timeoutMs)
    if (result.code !== 0) return { ok: false, output: `${command}\n${tail(result.stderr || result.stdout)}` }
  }
  return { ok: true, output: "" }
}

export async function runChecks(directory: string, project: Project, timeoutMs: number): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const check of project.checks) {
    const result = await shell(check.command, directory, timeoutMs)
    const output = `${result.stdout}\n${result.stderr}`
    results.push({
      name: check.name,
      passed: result.code === 0,
      warnings: countWarnings(output),
      durationMs: result.durationMs,
      output: tail(output, 60),
      timedOut: result.timedOut,
    })
  }
  return results
}

export function compare(base: CheckResult[], candidate: CheckResult[]) {
  let regressions = 0
  let fixes = 0
  let newWarnings = 0
  for (const result of candidate) {
    const before = base.find((entry) => entry.name === result.name)
    if (!before) continue
    if (before.passed && !result.passed) regressions++
    if (!before.passed && result.passed) fixes++
    newWarnings += Math.max(0, result.warnings - before.warnings)
  }
  return { regressions, fixes, newWarnings }
}
