/**
 * The packaging half of the `curl … /code/install.sh | sh` path.
 *
 * `packages/redrob/script/cdn.ts` writes archives that a script living in another repository has to
 * be able to read, so the script is the fixture: `test/fixture/console-install.sh` is the exact bytes
 * Console serves from `GET /code/install.sh`, and these tests run it. Nothing is asserted about the
 * archives that is not asserted by making the real installer install one.
 *
 * Regenerate the fixture from a redrob-console checkout when that script changes:
 *
 *     bun -e 'import { codeInstallScript, DEFAULT_CODE_VERSION, DEFAULT_CONSOLE_ORIGIN } from
 *       "./apps/web/src/lib/code/install-script.ts";
 *       await Bun.write("<here>/console-install.sh", codeInstallScript({ base: null,
 *       version: DEFAULT_CODE_VERSION, origin: DEFAULT_CONSOLE_ORIGIN }))'
 *
 * The bucket is loopback HTTP rather than a real one: the installer allows `http://127.0.0.1` for
 * exactly this, and there is no published bucket to point at yet.
 */

import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import path from "path"
import {
  CDN_BINARY_NAME,
  CDN_DESKTOP_TARGETS,
  CDN_TARGETS,
  CDN_VERSION_NAME,
  cdnAssetName,
  cdnAssetNames,
  cdnTarget,
  pack,
  packedAssetNames,
  upload,
} from "../../script/cdn"
import { tmpdir } from "../fixture/fixture"
import { Installation } from "../../src/installation"

const script = path.join(import.meta.dir, "../fixture/console-install.sh")
const version = "0.0.0-cdn-test"

/** The archive the installer will pick on this machine, since it decides that from `uname`. */
const host = {
  os: process.platform === "darwin" ? "darwin" : "linux",
  arch: process.arch === "arm64" ? "arm64" : "x64",
}

/**
 * `install.sh` is a POSIX shell script for macOS and Linux, and `pack` runs on the Linux publish
 * runner, so on Windows there is nothing here to assert beyond the names and the skip reasons.
 */
const supported = process.platform === "darwin" || process.platform === "linux"

async function fakeBuild(dist: string) {
  for (const target of CDN_TARGETS) {
    const binary = path.join(dist, `redrob-${target.os}-${target.arch}`, "bin", "redrob")
    await Bun.write(binary, `#!/bin/sh\necho "redrob-code ${target.os}-${target.arch} ${version}"\n`)
    await $`chmod 755 ${binary}`
  }
}

/** A CDN: whatever `pack` wrote, over loopback, optionally with the sidecars missing. */
function serveArchives(root: string, options: { withoutChecksums?: boolean } = {}) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const name = new URL(request.url).pathname
      if (options.withoutChecksums && name.endsWith(".sha256")) return new Response("not found", { status: 404 })
      const file = Bun.file(path.join(root, name))
      if (!(await file.exists())) return new Response("not found", { status: 404 })
      return new Response(file)
    },
  })
}

/** An S3-compatible bucket that keeps what it is given and serves it back at the same key. */
function serveBucket(bucket: string) {
  const objects = new Map<string, { type: string; body: ArrayBuffer }>()
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const key = new URL(request.url).pathname.replace(`/${bucket}/`, "")
      if (request.method === "PUT") {
        objects.set(key, { type: request.headers.get("content-type") ?? "", body: await request.arrayBuffer() })
        return new Response(null, { status: 200, headers: { etag: `"${key}"` } })
      }
      const object = objects.get(key)
      if (!object) return new Response("no such key", { status: 404 })
      return new Response(object.body, { headers: { "content-type": object.type } })
    },
  })
  return { server, objects }
}

function runInstall(input: { base?: string; version?: string; installDir: string; home: string }) {
  return $`sh ${script}`
    .env({
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: input.home,
      REDROB_CODE_INSTALL_DIR: input.installDir,
      ...(input.base ? { REDROB_CODE_DOWNLOAD_BASE: input.base } : {}),
      ...(input.version ? { REDROB_CODE_VERSION: input.version } : {}),
    })
    .nothrow()
    .quiet()
}

describe("cdn archives", () => {
  test.skipIf(!supported)("packs the four assets install.sh can ask for, with matching sidecars", async () => {
    await using tmp = await tmpdir()
    const dist = path.join(tmp.path, "dist")
    const out = path.join(dist, "cdn")
    await fakeBuild(dist)

    const packed = await pack({ dist, out, version })
    expect(packed.map((item) => item.asset).sort()).toEqual([
      "redrob-code-darwin-arm64.tar.gz",
      "redrob-code-darwin-x64.tar.gz",
      "redrob-code-linux-arm64.tar.gz",
      "redrob-code-linux-x64.tar.gz",
    ])

    for (const item of packed) {
      expect(item.archive).toBe(path.join(out, version, item.asset))
      expect(await Bun.file(`${item.archive}.sha256`).text()).toBe(`${item.sha256}  ${item.asset}\n`)
      // The digest the installer compares against has to be the digest of the bytes it downloads.
      const hasher = new Bun.CryptoHasher("sha256")
      hasher.update(await Bun.file(item.archive).arrayBuffer())
      expect(item.sha256).toBe(hasher.digest("hex"))

      const listing = await $`tar -tvzf ${item.archive}`.text()
      expect(listing).toContain(CDN_BINARY_NAME)
      expect(listing.split("\n").find((line) => line.includes(CDN_BINARY_NAME))).toContain("rwxr-xr-x")
    }

    // What `Installation.latest()` reads to decide an upgrade is available.
    expect(await Bun.file(path.join(out, version, CDN_VERSION_NAME)).text()).toBe(`${version}\n`)
  })

  /**
   * The desktop applications bundle this engine and their Windows packaging jobs have no credential
   * for the private repository the signed Windows CLI is released to, so the archive has to be here.
   * It carries `redrob-code.exe`, which is the name those jobs look for after unpacking.
   */
  test.skipIf(!supported)("packs a Windows engine archive for the desktop applications", async () => {
    await using tmp = await tmpdir()
    const dist = path.join(tmp.path, "dist")
    const out = path.join(dist, "cdn")
    await fakeBuild(dist)

    // Absent, the release still publishes: only the installer's four are required.
    expect((await pack({ dist, out, version })).map((item) => item.asset)).not.toContain(
      cdnAssetName("windows", "x64"),
    )
    expect(await packedAssetNames(out, version)).toEqual(cdnAssetNames())

    const windows = CDN_DESKTOP_TARGETS[0]
    const signed = path.join(dist, `redrob-${windows.os}-${windows.arch}`, "bin", windows.binary)
    await Bun.write(signed, "MZ not really a PE, but distinct bytes\n")

    const packed = await pack({ dist, out, version })
    const archive = packed.find((item) => item.asset === cdnAssetName("windows", "x64"))
    expect(archive).toBeDefined()
    expect(await Bun.file(`${archive!.archive}.sha256`).text()).toBe(`${archive!.sha256}  ${archive!.asset}\n`)
    expect(await $`tar -tzf ${archive!.archive}`.text()).toContain(`${CDN_BINARY_NAME}.exe`)

    // install.sh never asks for it, so its own contract is unchanged; the upload still carries it.
    expect(cdnAssetNames()).not.toContain(cdnAssetName("windows", "x64"))
    expect(await packedAssetNames(out, version)).toEqual([
      ...cdnAssetNames(),
      cdnAssetName("windows", "x64"),
      `${cdnAssetName("windows", "x64")}.sha256`,
    ])
  })

  test("the fixture installer still fetches the keys pack writes", async () => {
    const source = await Bun.file(script).text()
    expect(source).toContain(`BIN_NAME="${CDN_BINARY_NAME}"`)
    expect(source).toContain('ASSET="$BIN_NAME-$OS-$ARCH.tar.gz"')
    expect(source).toContain('ASSET_URL="$DOWNLOAD_BASE/$VERSION/$ASSET"')
    expect(source).toContain('"$ASSET_URL.sha256"')
    expect(source).toContain('-name "$BIN_NAME"')
    expect(cdnAssetName("linux", "x64")).toBe(`${CDN_BINARY_NAME}-linux-x64.tar.gz`)
    expect(cdnAssetNames()).toHaveLength(8)
  })

  test.skipIf(!supported)("install.sh installs the packed archive for this platform", async () => {
    await using tmp = await tmpdir()
    const dist = path.join(tmp.path, "dist")
    const out = path.join(dist, "cdn")
    await fakeBuild(dist)
    await pack({ dist, out, version })

    using server = serveArchives(out)
    const installed = path.join(tmp.path, "bin", CDN_BINARY_NAME)
    const result = await runInstall({
      base: server.url.origin,
      version,
      installDir: path.dirname(installed),
      home: tmp.path,
    })

    expect(result.stderr.toString()).toBe("")
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain("Checksum verified.")
    expect(await $`${installed}`.text()).toContain(`${host.os}-${host.arch}`)
  })

  test.skipIf(!supported)("install.sh refuses an archive that does not match its sidecar", async () => {
    await using tmp = await tmpdir()
    const dist = path.join(tmp.path, "dist")
    const out = path.join(dist, "cdn")
    await fakeBuild(dist)
    await pack({ dist, out, version })

    const archive = path.join(out, version, cdnAssetName(host.os, host.arch))
    await Bun.file(archive).write(
      await Bun.file(archive)
        .bytes()
        .then((bytes) => new Uint8Array([...bytes, 0])),
    )

    using server = serveArchives(out)
    const installDir = path.join(tmp.path, "bin")
    const result = await runInstall({ base: server.url.origin, version, installDir, home: tmp.path })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("Checksum mismatch")
    expect(await Bun.file(path.join(installDir, CDN_BINARY_NAME)).exists()).toBe(false)
  })

  test.skipIf(!supported)("install.sh refuses a build with no published checksum", async () => {
    await using tmp = await tmpdir()
    const dist = path.join(tmp.path, "dist")
    const out = path.join(dist, "cdn")
    await fakeBuild(dist)
    await pack({ dist, out, version })

    using server = serveArchives(out, { withoutChecksums: true })
    const installDir = path.join(tmp.path, "bin")
    const result = await runInstall({ base: server.url.origin, version, installDir, home: tmp.path })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("No checksum published")
    expect(await Bun.file(path.join(installDir, CDN_BINARY_NAME)).exists()).toBe(false)
  })

  test.skipIf(!supported)("install.sh installs nothing while no download base is configured", async () => {
    await using tmp = await tmpdir()
    const installDir = path.join(tmp.path, "bin")
    const result = await runInstall({ installDir, home: tmp.path })

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("not published yet")
    expect(await Bun.file(path.join(installDir, CDN_BINARY_NAME)).exists()).toBe(false)
  })
})

describe("cdn upload", () => {
  test("skips, with the reason, until a bucket and credentials are configured", () => {
    expect(cdnTarget({})).toEqual({ configured: false, reason: "REDROB_CODE_CDN_BUCKET is not set" })
    expect(cdnTarget({ REDROB_CODE_CDN_BUCKET: "redrob-code" })).toEqual({
      configured: false,
      reason:
        "REDROB_CODE_CDN_BUCKET is redrob-code but REDROB_CODE_CDN_ACCESS_KEY_ID and REDROB_CODE_CDN_SECRET_ACCESS_KEY are not both set",
    })

    const configured = cdnTarget({
      REDROB_CODE_CDN_BUCKET: "redrob-code",
      AWS_ACCESS_KEY_ID: "ambient-id",
      AWS_SECRET_ACCESS_KEY: "ambient-secret",
      REDROB_CODE_CDN_PREFIX: "/code/",
      REDROB_CODE_CDN_LATEST: "0",
    })
    expect(configured).toMatchObject({
      configured: true,
      bucket: "redrob-code",
      accessKeyId: "ambient-id",
      prefix: "code/",
      latest: false,
      publicRead: false,
      region: "us-east-1",
    })
  })

  test("returns the skip reason instead of publishing somewhere else", async () => {
    await using tmp = await tmpdir()
    const result = await upload({ dir: path.join(tmp.path, "cdn"), version, env: {} })
    expect(result).toEqual({ configured: false, reason: "REDROB_CODE_CDN_BUCKET is not set" })
  })

  test.skipIf(!supported)("writes every asset under the version prefix and latest, ready for install.sh", async () => {
    await using tmp = await tmpdir()
    const dist = path.join(tmp.path, "dist")
    const out = path.join(dist, "cdn")
    await fakeBuild(dist)
    const packed = await pack({ dist, out, version })

    const bucket = "redrob-code-builds"
    const fake = serveBucket(bucket)
    using server = fake.server
    const result = await upload({
      dir: out,
      version,
      env: {
        REDROB_CODE_CDN_BUCKET: bucket,
        REDROB_CODE_CDN_ACCESS_KEY_ID: "test-id",
        REDROB_CODE_CDN_SECRET_ACCESS_KEY: "test-secret",
        REDROB_CODE_CDN_ENDPOINT: server.url.origin,
      },
    })

    expect(result).toMatchObject({ configured: true, bucket })
    expect(result.configured && result.keys).toEqual([
      ...cdnAssetNames().flatMap((name) => [`${version}/${name}`, `latest/${name}`]),
      `${version}/${CDN_VERSION_NAME}`,
      `latest/${CDN_VERSION_NAME}`,
    ])
    expect([...fake.objects.keys()].length).toBe(18)
    // The marker goes up after every archive it describes, so a reader never sees a version whose
    // download is not there yet.
    expect([...fake.objects.keys()].slice(-2)).toEqual([`${version}/${CDN_VERSION_NAME}`, `latest/${CDN_VERSION_NAME}`])
    expect(new TextDecoder().decode(fake.objects.get(`latest/${CDN_VERSION_NAME}`)?.body)).toBe(`${version}\n`)
    expect(fake.objects.get(`latest/${CDN_VERSION_NAME}`)?.type).toBe("text/plain; charset=utf-8")
    expect(fake.objects.get(`latest/${cdnAssetName("linux", "x64")}`)?.type).toBe("application/gzip")
    expect(fake.objects.get(`latest/${cdnAssetName("linux", "x64")}.sha256`)?.type).toBe("text/plain; charset=utf-8")

    // What the bucket now holds is what install.sh downloads, so ask it to.
    const installed = path.join(tmp.path, "bin", CDN_BINARY_NAME)
    const install = await runInstall({
      base: `${server.url.origin}/${bucket}`,
      version: "latest",
      installDir: path.dirname(installed),
      home: tmp.path,
    })
    expect(install.stderr.toString()).toBe("")
    expect(install.exitCode).toBe(0)
    expect(await $`${installed}`.text()).toContain(`${host.os}-${host.arch}`)
    expect(packed.find((item) => item.os === host.os && item.arch === host.arch)?.sha256).toBe(
      new Bun.CryptoHasher("sha256")
        .update(fake.objects.get(`latest/${cdnAssetName(host.os, host.arch)}`)!.body)
        .digest("hex"),
    )
  })

  test.skipIf(!supported)("refuses to overwrite an existing immutable version prefix", async () => {
    await using tmp = await tmpdir()
    const dist = path.join(tmp.path, "dist")
    const out = path.join(dist, "cdn")
    await fakeBuild(dist)
    await pack({ dist, out, version })

    const bucket = "redrob-code-builds"
    const fake = serveBucket(bucket)
    using server = fake.server
    const env = {
      REDROB_CODE_CDN_BUCKET: bucket,
      REDROB_CODE_CDN_ACCESS_KEY_ID: "test-id",
      REDROB_CODE_CDN_SECRET_ACCESS_KEY: "test-secret",
      REDROB_CODE_CDN_ENDPOINT: server.url.origin,
    }
    await upload({ dir: out, version, env })
    await expect(upload({ dir: out, version, env })).rejects.toThrow("immutable")
  })

  /**
   * The upgrade half: what a running Redrob Code reads to decide there is a newer build has to be a
   * version this same bucket can hand to `install.sh`, so read it the way `Installation.latest()`
   * does and install exactly what it says.
   */
  test.skipIf(!supported)("names a version install.sh can then install", async () => {
    await using tmp = await tmpdir()
    const dist = path.join(tmp.path, "dist")
    const out = path.join(dist, "cdn")
    await fakeBuild(dist)
    await pack({ dist, out, version })

    const bucket = "redrob-code-builds"
    const fake = serveBucket(bucket)
    using server = fake.server
    const base = `${server.url.origin}/${bucket}`
    await upload({
      dir: out,
      version,
      env: {
        REDROB_CODE_CDN_BUCKET: bucket,
        REDROB_CODE_CDN_ACCESS_KEY_ID: "test-id",
        REDROB_CODE_CDN_SECRET_ACCESS_KEY: "test-secret",
        REDROB_CODE_CDN_ENDPOINT: server.url.origin,
      },
    })

    const url = Installation.cdnVersionUrl({ REDROB_CODE_DOWNLOAD_BASE: base })
    expect(url).toBe(`${base}/latest/${CDN_VERSION_NAME}`)
    const published = (await fetch(url).then((response) => response.text())).trim()
    expect(published).toBe(version)

    const installed = path.join(tmp.path, "bin", CDN_BINARY_NAME)
    const install = await runInstall({
      base,
      version: published,
      installDir: path.dirname(installed),
      home: tmp.path,
    })
    expect(install.stderr.toString()).toBe("")
    expect(install.exitCode).toBe(0)
    expect(await $`${installed}`.text()).toContain(`${host.os}-${host.arch}`)
  })
})
