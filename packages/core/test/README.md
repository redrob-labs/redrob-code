# Why `packages/core` tests do not run with `--parallel`

`packages/redrob` runs its tests with `bun test --parallel`, which took the suite that
dominates CI from 381s to about 127s. `packages/core` deliberately does not, and this note
exists so the flag is not "helpfully" added back.

## What happens if you add it

CI ran 377 of 933 tests and failed 75 of them. Not flakiness — 74 test files hit the same
error shape:

```
ReferenceError: Cannot access 'node' before initialization
  at packages/core/src/config.ts:244:23
```

with two more at `src/database/migration.ts:32` (`migrations`) and one at
`src/util/effect-flock.ts:283`.

## Why the flag is not the bug

`--parallel` implies `--isolate`: each worker gets its own module registry, so a test file
loads modules in whatever order its own imports dictate. Serially, all 114 files share one
registry, so whichever file ran first warmed the import order for everyone after it.

The modules underneath have import cycles and reference each other at MODULE level:

```ts
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, Location.node, Policy.node],
})
```

Reading `Global.node` while `Global` is still mid-evaluation is a temporal dead zone. Under
one shared registry the first file to load happened to establish a working order and the
rest inherited it. Under isolation each file rolls the dice again.

So the suite was never order-independent. It passed because it always ran in the same order.

This is not hypothetical outside tests: `plugin/provider.ts` had the same defect, threw when
imported before anything else had pulled the plugins in, and is fixed in the same change
that added this note — `ProviderPlugins` is now built on call instead of at module
evaluation. That fix made one file work standalone. It did not fix the other 74.

## What fixing it properly requires

The `node`-with-`deps` pattern is used across the package, and every site lists other
modules' `node` at module level. Making it order-independent means deferring those
references — a thunk, a getter, or a registry resolved on first use — at every site, not
just the ones the tests happen to catch.

That is worth doing: an import-order dependency is a latent production hazard, and the
ordering that currently works is a coincidence nothing enforces. It is a larger change than
a test flag, which is why it is written down rather than attempted alongside one.

Until then `core` runs serially. It costs 44s in CI, so parallelizing it was worth ~26s —
never the reason CI was slow.
