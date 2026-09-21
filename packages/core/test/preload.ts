import fs from "fs/promises"
import os from "os"
import path from "path"

/*
  Isolate the XDG data directory BEFORE anything imports `global.ts`.

  `Global.Path.data` is computed once at module load from `xdgData`, and `auth.json` lives there. The
  suite's own `home` seam (`REDROB_TEST_HOME`) does not cover it, so the ModelsDev "no key" tests --
  which clear `REDROB_API_KEY` and then assert the static fallback is served -- still found a real
  credential on any machine where somebody had run `redrob providers login`. `resolveApiKey()` reads
  three sources in order: the env var, the Integration store, and this file. The tests stub the second
  and clear the first.

  The result was three tests that passed in CI, where no profile exists, and failed on a developer's own
  machine -- reporting the live catalogue's figures (`limit.output: 64000`) instead of the fallback's
  (`32000`). A test that is green only because the environment happens to be empty is not testing what
  it says it is, and the variable it depends on is invisible from the assertion.

  Set here rather than given a new seam in production code: nothing about the CLI's real path resolution
  is wrong, and `XDG_DATA_HOME` is the standard way to say where that directory is.
*/
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "redrob-core-test-data-"))
process.env.XDG_DATA_HOME = dataDir

process.env.REDROB_DB = ":memory:"
// Gate the console /models fetch off so core tests stay offline/deterministic; the
// ModelsDev.Service then serves the static console fallback catalog (redrob/auto and the rest of
// CONSOLE_MODELS).
process.env.REDROB_DISABLE_MODELS_FETCH = "true"
