# apps/studio

The Redrob Code desktop interface: React 19, Vite, `@redrob-labs/ui`, TanStack Query. It runs only
inside `apps/desktop`, which supplies `window.redrobCode` (types in `@redrob-code/desktop/bridge`).

- **Talk to the engine with `@redrob-code/client`** through `useEngine()` (`src/engine.tsx`). There is
  one event stream for the whole window; subscribe with `useEngineEvents`, do not open another.
- **Every visible string is a key in `src/i18n.ts`**, in English and Korean. `test/lib.test.ts` fails if a
  key or a `{placeholder}` is missing from either table.
- **Use the design system** (`@redrob-labs/ui`) for components and tokens. `src/styles.css` is layout
  only; it defines no colours of its own beyond diff highlights.
- **Effects return a function or nothing.** An expression-bodied `useEffect(() => el.scrollIntoView())`
  returns a promise in current Chromium and crashes React on unmount.
- **The bundle is served from `oc://renderer/`**, so asset URLs are relative (`base: "./"`) and the CSP
  in `index.html` allows only the local engine.

Verify with `bun run typecheck`, `bun test` and `bun run build`.
