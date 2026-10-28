# Redrob Code Kotlin SDK

Kotlin Multiplatform client for the Redrob Code server API, package `ai.redrob.code.sdk`.
It uses ktor and kotlinx.serialization.

## What is generated and what is not

- Generated from `packages/sdk/openapi.json` by openapi-generator (`kotlin`, library
  `multiplatform`), pinned in `script/generate.ts`: `ai.redrob.code.sdk.apis`,
  `ai.redrob.code.sdk.models`, and the Gradle build files.
- Hand-written, never touched by the generator (see `.openapi-generator-ignore`):
  `src/commonMain/kotlin/ai/redrob/code/sdk/relay/Machines.kt`. It holds the `desk.machine`
  relay frame payload, the machine list body from `GET /mobile/machines` and
  `GET /desktop/machines`, and `GET /desk/capabilities`. OpenAPI cannot describe relay frames.
  Keep it in step with `packages/redrob/src/desk/frames.ts`.

## Running the generator

It runs once at release time, not on every change. It needs Java 11 or newer.

```sh
./script/generate.ts                   # refresh packages/sdk/openapi.json (repo root)
bun packages/sdk/kotlin/script/generate.ts
```

The first run downloads the pinned generator jar into `~/.cache/redrob/`.
To move to a new generator version, change `GENERATOR_VERSION` in `script/generate.ts`.
