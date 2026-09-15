#!/usr/bin/env bun
/**
 * The archives `https://console.redrob.ai/code/install.sh` downloads.
 *
 * That script is the contract and it is narrow: it fetches
 * `$REDROB_CODE_DOWNLOAD_BASE/$VERSION/redrob-code-$OS-$ARCH.tar.gz`, fetches the sidecar
 * `<archive>.sha256` beside it, refuses to install unless the digests match, untars the archive and
 * looks for a file named `redrob-code` anywhere inside it. `$OS` is `darwin` or `linux` and `$ARCH`
 * is `x64` or `arm64`; there is no Windows build on that path, which is why this file packs four
 * archives and not twelve. Anything named differently is invisible to the installer, so the names
 * are constants here and `pack` reads back every archive it wrote before returning.
 *
 * Nothing is uploaded until a bucket exists. `REDROB_CODE_CDN_BUCKET` plus credentials are the
 * switch, and without them `upload` reports which variable is missing and the release carries on:
 * a publish must not fail over a CDN nobody has created yet. There is deliberately no fallback to
 * GitHub Releases either. The public install path is this bucket or nothing, because a 404 from a
 * host we guessed at is worse than a script that says the builds are not published.
 *
 * The x64 archives carry the AVX2 builds rather than the `-baseline` ones. `install.sh` cannot probe
 * CPU features the way the npm postinstall does, so this is a choice rather than a detection, and it
 * is the same one npm makes for a modern machine.
 *
 * This is not the repository's own `./install`, which is served from `code.redrob.ai/install` and
 * reads GitHub Releases. That one is untouched by any of this. Two installers exist because two
 * hosts do, and only Console's is CDN-only.
 */

import { $ } from "bun"
import path from "path"

/** The executable inside the archive, and the name `install.sh` searches the unpacked tree for. */
export const CDN_BINARY_NAME = "redrob-code"

/**
 * The version marker beside the archives, which is how a running Redrob Code learns there is a
 * newer build: `Installation.latest()` reads `<base>/latest/version` because it can install exactly
 * what that names, and there is nothing else under the prefix that says a version at all.
 *
 * It is uploaded after every archive and sidecar, so a reader that catches the window sees the
 * previous version, never a version whose download is half there. `install.sh` does not read it.
 */
export const CDN_VERSION_NAME = "version"

/** The four platforms `install.sh` can ask for. */
export const CDN_TARGETS = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
] as const

/**
 * Windows, which `install.sh` cannot ask for and the desktop applications need.
 *
 * Redrob Work bundles this engine as a sidecar, and its Windows packaging job has no credential for
 * the private repository the signed Windows CLI is released to. So the same archive shape goes to the
 * CDN for it to fetch anonymously, verified against the same `.sha256` sidecar. The binary inside is
 * the Azure-signed one, which is why these are packed from the signed artifact rather than the
 * unsigned build: a public download nobody signed is not one to hand a desktop installer.
 *
 * These are absent from `cdnAssetNames()` on purpose. That list is the installer's contract, and a
 * name it would never request has no business making it throw.
 */
export const CDN_DESKTOP_TARGETS = [
  { os: "windows", arch: "x64", binary: "redrob.exe", installed: `${CDN_BINARY_NAME}.exe` },
  { os: "windows", arch: "arm64", binary: "redrob.exe", installed: `${CDN_BINARY_NAME}.exe` },
] as const

export function cdnAssetName(os: string, arch: string) {
  return `${CDN_BINARY_NAME}-${os}-${arch}.tar.gz`
}

/** Every object key under a version prefix, in the order the installer needs them to exist. */
export function cdnAssetNames() {
  return CDN_TARGETS.flatMap((target) => {
    const asset = cdnAssetName(target.os, target.arch)
    return [asset, `${asset}.sha256`]
  })
}

/**
 * Pack `<dist>/redrob-<os>-<arch>/bin` into `<out>/<version>/redrob-code-<os>-<arch>.tar.gz`.
 *
 * The build calls its output `redrob`, the installer looks for `redrob-code`, so the binary is
 * staged under the name the installer wants rather than renamed on the way in on the user's machine.
 * The rest of `bin` comes along because the compiled binary is not always alone in there. The version
 * marker is written here too, so the directory holds every object the prefix will.
 *
 * The four `install.sh` archives are required and a missing build is an error. Windows is packed
 * when its signed binary is there and skipped when it is not, because it arrives from a different
 * job than the other three and a release must not stop over the archive no installer asks for.
 */
export async function pack(input: { dist: string; out: string; version: string }) {
  const dir = path.join(input.out, input.version)
  await $`rm -rf ${dir}`
  await $`mkdir -p ${dir}`

  const packOne = async (target: { os: string; arch: string; binary?: string; installed?: string }) => {
    const source = path.join(input.dist, `redrob-${target.os}-${target.arch}`, "bin")
    const built = target.binary ?? "redrob"
    const installed = target.installed ?? CDN_BINARY_NAME
    if (!(await Bun.file(path.join(source, built)).exists())) return null

    const stage = path.join(input.out, "stage", `${target.os}-${target.arch}`)
    await $`rm -rf ${stage}`
    await $`mkdir -p ${stage}`
    await $`cp -R ${source}/. ${stage}/`
    await $`mv ${stage}/${built} ${stage}/${installed}`
    // The installer copies this file out and chmods it, but an archive that unpacks non-executable
    // is a bad artifact on its own, and GitHub artifact downloads drop the bit before we get here.
    await $`chmod 755 ${stage}/${installed}`

    const asset = cdnAssetName(target.os, target.arch)
    const archive = path.join(dir, asset)
    await $`tar -czf ${archive} .`.cwd(stage)

    const listing = await $`tar -tzf ${archive}`.text()
    if (!listing.split("\n").some((entry) => path.basename(entry.trim()) === installed))
      throw new Error(`${asset} has no ${installed} in it, so a downloader would reject it.`)

    const hasher = new Bun.CryptoHasher("sha256")
    const reader = Bun.file(archive).stream().getReader()
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) hasher.update(chunk.value)
    const sha256 = hasher.digest("hex")
    // Two spaces and the bare asset name: the format `sha256sum` writes, which is what the
    // installer cuts the first field out of, and what `sha256sum -c` reads back in this directory.
    await Bun.file(`${archive}.sha256`).write(`${sha256}  ${asset}\n`)

    return { os: target.os, arch: target.arch, asset, archive, sha256 }
  }

  const required = await Promise.all(
    CDN_TARGETS.map(async (target) => {
      const item = await packOne(target)
      if (!item)
        throw new Error(
          `no build at ${path.join(input.dist, `redrob-${target.os}-${target.arch}`, "bin", "redrob")}. Run packages/redrob/script/build.ts first.`,
        )
      return item
    }),
  )
  const desktop = (await Promise.all(CDN_DESKTOP_TARGETS.map(packOne))).filter((item) => item !== null)

  await $`rm -rf ${path.join(input.out, "stage")}`
  await Bun.file(path.join(dir, CDN_VERSION_NAME)).write(`${input.version}\n`)
  return [...required, ...desktop]
}

/**
 * Where the archives go, or why they are going nowhere.
 *
 * Credentials fall back to the ambient `AWS_*` names so a runner with a role, or a person with a
 * profile exported, does not need a second copy of them. The bucket does not: an upload target is
 * explicit, so that a workflow with AWS credentials in scope for another reason cannot start writing
 * release archives into whatever `AWS_BUCKET` happens to say.
 */
export function cdnTarget(env: Record<string, string | undefined> = process.env) {
  const bucket = env["REDROB_CODE_CDN_BUCKET"]?.trim()
  if (!bucket) return { configured: false as const, reason: "REDROB_CODE_CDN_BUCKET is not set" }

  const accessKeyId = env["REDROB_CODE_CDN_ACCESS_KEY_ID"]?.trim() || env["AWS_ACCESS_KEY_ID"]?.trim()
  const secretAccessKey = env["REDROB_CODE_CDN_SECRET_ACCESS_KEY"]?.trim() || env["AWS_SECRET_ACCESS_KEY"]?.trim()
  if (!accessKeyId || !secretAccessKey)
    return {
      configured: false as const,
      reason: `REDROB_CODE_CDN_BUCKET is ${bucket} but REDROB_CODE_CDN_ACCESS_KEY_ID and REDROB_CODE_CDN_SECRET_ACCESS_KEY are not both set`,
    }

  const prefix = env["REDROB_CODE_CDN_PREFIX"]?.trim().replace(/^\/+|\/+$/g, "")
  return {
    configured: true as const,
    bucket,
    accessKeyId,
    secretAccessKey,
    sessionToken: env["REDROB_CODE_CDN_SESSION_TOKEN"]?.trim() || env["AWS_SESSION_TOKEN"]?.trim(),
    region: env["REDROB_CODE_CDN_REGION"]?.trim() || env["AWS_REGION"]?.trim() || "us-east-1",
    endpoint: env["REDROB_CODE_CDN_ENDPOINT"]?.trim(),
    prefix: prefix ? `${prefix}/` : "",
    // Buckets fronted by CloudFront with an origin access control take no object ACLs at all, and
    // sending one to a bucket with ownership enforced is an error, so this is opt in.
    publicRead: env["REDROB_CODE_CDN_PUBLIC_READ"]?.trim() === "1",
    // `latest` is what install.sh asks for when Console sets no REDROB_CODE_VERSION, so it is
    // mirrored by default and turned off for previews that should not become the default download.
    latest: env["REDROB_CODE_CDN_LATEST"]?.trim() !== "0",
  }
}

/**
 * Every asset name under `<dir>/<version>/` that this release actually has.
 *
 * The installer's four are always named, so a missing one still fails the upload rather than
 * publishing a version prefix the installer cannot install from. Windows is named only when it was
 * packed, which is how a release without the signed Windows binary publishes the rest.
 */
export async function packedAssetNames(dir: string, version: string) {
  const names = [...cdnAssetNames()]
  for (const target of CDN_DESKTOP_TARGETS) {
    const asset = cdnAssetName(target.os, target.arch)
    if (await Bun.file(path.join(dir, version, asset)).exists()) names.push(asset, `${asset}.sha256`)
  }
  return names
}

/**
 * Put the packed archives and their sidecars under `<version>/`, and under `latest/` as well unless
 * that was turned off. Each archive goes up before the sidecar describing it, so a reader who catches
 * the window under a new version prefix sees a missing checksum, which the installer refuses on.
 * Overwriting `latest/` has the narrower but worse window, a sidecar still describing the previous
 * archive, which reads as a corrupt download: a version prefix is the safer thing for Console to name
 * while a release is in flight. The version marker goes up after all of them, since it is what tells
 * a running Redrob Code to fetch these archives.
 */
export async function upload(input: { dir: string; version: string; env?: Record<string, string | undefined> }) {
  const target = cdnTarget(input.env)
  if (!target.configured) return target

  const client = new Bun.S3Client({
    bucket: target.bucket,
    region: target.region,
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
    ...(target.sessionToken ? { sessionToken: target.sessionToken } : {}),
    ...(target.endpoint ? { endpoint: target.endpoint } : {}),
  })

  const versionMarkerKey = `${target.prefix}${input.version}/${CDN_VERSION_NAME}`
  if (await client.file(versionMarkerKey).exists()) {
    throw new Error(
      `CDN version prefix ${input.version} is immutable: ${versionMarkerKey} already exists. Publish a new version instead.`,
    )
  }

  const prefixes = target.latest ? [input.version, "latest"] : [input.version]
  const keys: string[] = []
  for (const name of await packedAssetNames(input.dir, input.version)) {
    const local = path.join(input.dir, input.version, name)
    if (!(await Bun.file(local).exists())) throw new Error(`${local} was not packed, so ${name} cannot be uploaded.`)
    for (const prefix of prefixes) {
      const key = `${target.prefix}${prefix}/${name}`
      await client.write(key, Bun.file(local), {
        type: name.endsWith(".sha256") ? "text/plain; charset=utf-8" : "application/gzip",
        ...(target.publicRead ? { acl: "public-read" as const } : {}),
      })
      keys.push(key)
    }
  }

  for (const prefix of prefixes) {
    const key = `${target.prefix}${prefix}/${CDN_VERSION_NAME}`
    await client.write(key, `${input.version}\n`, {
      type: "text/plain; charset=utf-8",
      ...(target.publicRead ? { acl: "public-read" as const } : {}),
    })
    keys.push(key)
  }

  return { configured: true as const, bucket: target.bucket, keys }
}

if (import.meta.main) {
  const version = process.env["REDROB_CODE_CDN_VERSION"]?.trim() || process.env["REDROB_VERSION"]?.trim()
  if (!version) throw new Error("REDROB_VERSION is not set, so there is no version prefix to publish under.")

  const dist = process.env["REDROB_CODE_CDN_DIST"]?.trim() || path.resolve(import.meta.dir, "../dist")
  const out = path.join(dist, "cdn")
  for (const item of await pack({ dist, out, version }))
    console.log(`packed ${path.relative(dist, path.join(out, version, item.asset))} ${item.sha256}`)

  const result = await upload({ dir: out, version })
  if (!result.configured) {
    console.log(`skipped the CDN upload: ${result.reason}`)
    console.log(`the archives are in ${path.join(out, version)} and nothing else was published in their place`)
    console.log("install.sh stays honest about there being no download until REDROB_CODE_DOWNLOAD_BASE is set")
    process.exit(0)
  }

  for (const key of result.keys) console.log(`uploaded ${result.bucket}/${key}`)
  console.log(`set REDROB_CODE_DOWNLOAD_BASE on Console to the public URL of ${result.bucket}, and`)
  console.log(`REDROB_CODE_VERSION to ${version} unless latest/ is the one to serve`)
}
