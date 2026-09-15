# Why the test suites do not run with `bun test --parallel`

Two attempts, two CI rejections, two different causes. Written down so the flag is not
added back as an obvious optimisation — it is obvious, it is a large speedup locally, and it
does not survive a CI runner.

Locally `--parallel` took the whole workspace from about 4m to 1m21s with zero failures
across five runs at two worker counts. That measurement was real and it did not transfer.

## Cause 1 — `packages/core` is not order-independent

CI ran 377 of 933 tests and failed 75. Not flakiness: 74 test files hit one error shape,

```
ReferenceError: Cannot access 'node' before initialization
  at packages/core/src/config.ts:244:23
```

with two more at `src/database/migration.ts:32` and one at `src/util/effect-flock.ts:283`.

`--parallel` implies `--isolate`: each worker gets its own module registry, so every file
loads modules in whatever order its own imports dictate. Serially, all 114 files share one
registry and whichever file ran first warmed the order for the rest.

The modules underneath reference each other at MODULE level:

```ts
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, Location.node, Policy.node],
})
```

Reading `Global.node` while `Global` is still evaluating is a temporal dead zone. The suite
was never order-independent — it passed because it always ran in the same order.

One instance of this is FIXED in the change that added this file: `plugin/provider.ts` built
`ProviderPlugins` as a module-level array, threw when the file was imported before anything
else had pulled the plugins in, and now builds the list on call. That was a genuine defect
reachable outside tests, and it makes that one file pass standalone. It does not address the
other 74 sites.

## Cause 2 — timing-bounded tests fail under contention

With `core` back on serial, `packages/redrob` still failed:

```
test/session/prompt.test.ts:
(fail) running subtask preserves metadata after tool-call transition [5114.98ms]
  ^ this test timed out after 5000ms.
error: timed out waiting for running subtask metadata
  at packages/redrob/test/lib/effect.ts:175:37
```

That helper polls for state on a 20ms interval under an `Effect.timeoutOrElse` ceiling. Such
a test measures WALL CLOCK, so its budget is really a statement about how loaded the machine
is. Four workers sharing a CI runner's cores stretch a comfortable 3s wait past 5s.

`prompt.test.ts` is also the slowest file in the suite at ~20s, so it has the most room to
drift.

This is not a bug the flag caused; it is a property of any test whose assertion is "this
finished within N milliseconds". Parallelism is simply the first thing to expose it.

## What would actually work

**Shard across CI jobs rather than workers within one.** Each shard gets its own runner, so
per-test wall clock stays serial-like and the timing-bounded tests keep their headroom, while
total elapsed time still divides. `bun test` has no `--shard`, so this means computing a
deterministic file subset per matrix leg — a CI structure change, not a flag.

**Or make the timing-bounded tests wait on events instead of clocks**, which is the better
fix and the larger one. A poll loop with a wall-clock ceiling is a flake generator on any
machine slower than the author's.

Either is worth doing. Neither is a one-line change, which is why what landed here is the
import-cycle fix and this note.

## Where the time actually goes

Measured, so the next attempt starts from data rather than the build:

| | |
|---|---|
| release build, every platform | 1m 59s |
| `unit (linux)` total | ~10m |
| — of which unit tests | 6m 38s |
| — of which HttpApi gates | 1m 38s |
| turbo tasks that run | 5, not 23 |
| dominant package | 3351 tests, 251 files, 381s |
| other package | 933 tests, 114 files, 44s |

And the shape of the dominant suite: median file 1.41s, **no file under a second**, top 5
files only 15% of the total, 58 files spawn a process, 67 bind an HTTP server. There is no
hot spot to fix — it is an integration suite priced accordingly.
