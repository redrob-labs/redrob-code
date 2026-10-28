#!/usr/bin/env bun
// Generates the Kotlin Multiplatform client (ktor + kotlinx.serialization) from
// packages/sdk/openapi.json. Run at release time, after `./script/generate.ts` has
// refreshed openapi.json. Needs Java 11+ on PATH.
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import os from "os"
import path from "path"
import fs from "fs/promises"

// Pinned. Bump on purpose, never float.
const GENERATOR_VERSION = "7.10.0"
const jarUrl = `https://repo1.maven.org/maven2/org/openapitools/openapi-generator-cli/${GENERATOR_VERSION}/openapi-generator-cli-${GENERATOR_VERSION}.jar`
const cache = path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "redrob")
const jar = path.join(cache, `openapi-generator-cli-${GENERATOR_VERSION}.jar`)

if (!(await Bun.file(jar).exists())) {
  await fs.mkdir(cache, { recursive: true })
  const response = await fetch(jarUrl)
  if (!response.ok) throw new Error(`download ${jarUrl}: ${response.status}`)
  await Bun.write(jar, response)
}

const spec = path.resolve(dir, "../openapi.json")

// Files listed in .openapi-generator-ignore (README.md, the hand-written relay models)
// are left alone.
await $`java -jar ${jar} generate \
  -g kotlin \
  -i ${spec} \
  -o ${dir} \
  --library multiplatform \
  --package-name ai.redrob.code.sdk \
  --api-package ai.redrob.code.sdk.apis \
  --model-package ai.redrob.code.sdk.models \
  --additional-properties=serializationLibrary=kotlinx_serialization,groupId=ai.redrob,artifactId=redrob-code-sdk,enumPropertyNaming=UPPERCASE \
  --skip-validate-spec`
