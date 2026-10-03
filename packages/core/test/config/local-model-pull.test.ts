/**
 * PA-8's pull and listing, against the runtime's OWN published examples.
 *
 * Every fixture below is copied from the runtime's API reference, not written to match this
 * code. That distinction is the whole value: a fixture and a parser written from one reading
 * of a schema agree with each other and prove nothing about the real producer.
 *
 * Two traps the reference states explicitly, and both have a test:
 *   - `completed` MAY BE ABSENT while a layer is downloading ("Until any of the download is
 *     completed, the `completed` key may not be included").
 *   - `total` is per-LAYER, not per-model ("The number of files to be downloaded depends on
 *     the number of layers specified in the manifest").
 */
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { LocalModelFit } from "@redrob-code/core/config/plugin/local-model-fit"
import { LocalModelPull } from "@redrob-code/core/config/plugin/local-model-pull"

describe("urls", () => {
  test("join without doubling a slash", () => {
    expect(LocalModelPull.tagsUrl("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434/api/tags")
    expect(LocalModelPull.tagsUrl("http://127.0.0.1:11434/")).toBe("http://127.0.0.1:11434/api/tags")
    expect(LocalModelPull.pullUrl("http://127.0.0.1:11434///")).toBe("http://127.0.0.1:11434/api/pull")
  })

  test("the runtime API is a sibling of the OpenAI base, not a child of it", () => {
    // A local runtime is configured with its OpenAI base, conventionally `/v1` -- that is the
    // URL the provider needs and the one a user copies out of the runtime's own banner. But
    // `/api/tags` sits beside `/v1`, not under it.
    //
    // This is a REGRESSION TEST for a defect only an end-to-end run exposed: the first version
    // joined onto the configured base, produced `/v1/api/tags`, got a 404, and the command
    // printed "answering, with nothing installed" against a server that was serving two
    // models. A wrong statement that reads as a working feature, because a 404 and an empty
    // list are both "no models" to a caller that does not separate them.
    expect(LocalModelPull.tagsUrl("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434/api/tags")
    expect(LocalModelPull.pullUrl("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434/api/pull")
    // Any version segment, not just v1: some runtimes serve /v2.
    expect(LocalModelPull.tagsUrl("http://127.0.0.1:11434/v2")).toBe("http://127.0.0.1:11434/api/tags")
  })

  test("a path that merely CONTAINS a version segment is left alone", () => {
    // Only a TRAILING version segment is the OpenAI base. Stripping `/v1` from the middle of a
    // path would break a runtime served under a prefix by a reverse proxy.
    expect(LocalModelPull.tagsUrl("http://127.0.0.1:11434/v1/engine")).toBe(
      "http://127.0.0.1:11434/v1/engine/api/tags",
    )
  })
})

describe("readFrames", () => {
  // Verbatim from the reference's own pull example, in order.
  const stream = [
    '{"status":"pulling manifest"}',
    '{"status":"pulling digestname","digest":"digestname","total":2142590208,"completed":241970}',
    '{"status":"verifying sha256 digest"}',
    '{"status":"writing manifest"}',
    '{"status":"removing any unused layers"}',
    '{"status":"success"}',
  ].join("\n")

  test("reads every frame of the documented stream", () => {
    const frames = LocalModelPull.readFrames(stream)
    expect(frames.length).toBe(6)
    expect(frames[0]?.status).toBe("pulling manifest")
    expect(frames[1]?.total).toBe(2142590208)
    expect(frames[5]?.status).toBe("success")
  })

  test("status-only frames decode, carrying no byte counts", () => {
    const frames = LocalModelPull.readFrames('{"status":"writing manifest"}')
    expect(frames[0]?.total).toBeUndefined()
    expect(frames[0]?.completed).toBeUndefined()
  })

  test("a downloading frame with no completed key is still a frame", () => {
    // The reference says this one happens before the first bytes land. Requiring `completed`
    // would drop the frame that announces the size of the download.
    const frames = LocalModelPull.readFrames('{"status":"pulling abc","digest":"abc","total":2142590208}')
    expect(frames.length).toBe(1)
    expect(frames[0]?.total).toBe(2142590208)
    expect(frames[0]?.completed).toBeUndefined()
  })

  test("one unreadable line costs that line, not the transfer", () => {
    const frames = LocalModelPull.readFrames(
      ['{"status":"pulling manifest"}', "{ not json", '{"status":"success"}'].join("\n"),
    )
    expect(frames.map((frame) => frame.status)).toEqual(["pulling manifest", "success"])
  })

  test("a whole-body JSON parse would have failed on this stream", () => {
    // Guarding the reason the line-by-line reader exists: the runtime does not wrap the
    // frames in an array, so anyone "simplifying" this to one parse breaks every pull.
    expect(() => JSON.parse(stream)).toThrow()
  })
})

describe("readFrame", () => {
  test("marks only the success status as done", () => {
    const progress = LocalModelPull.readFrame({ status: "pulling manifest" })
    expect("error" in progress ? undefined : progress.done).toBe(false)
    const finished = LocalModelPull.readFrame({ status: "success" })
    expect("error" in finished ? undefined : finished.done).toBe(true)
  })

  test("reports layer bytes as layer bytes", () => {
    const progress = LocalModelPull.readFrame({ status: "pulling abc", total: 100, completed: 40 })
    if ("error" in progress) throw new Error("unexpected error frame")
    // Named for what they are. A caller that read these as whole-model progress would show a
    // bar that jumps back to zero on every layer of a multi-layer model.
    expect(progress.layerTotalBytes).toBe(100)
    expect(progress.layerCompletedBytes).toBe(40)
  })

  test("an in-band error is terminal, not progress", () => {
    // A 200 is already sent by the time this arrives. Treated as progress, the pull would
    // look like it is still running and never finish.
    const progress = LocalModelPull.readFrame({ status: "error", error: "model not found" })
    expect(progress).toEqual({ error: "model not found" })
  })

  test("an empty error string is not an error", () => {
    const progress = LocalModelPull.readFrame({ status: "success", error: "" })
    expect("error" in progress).toBe(false)
  })

  test("passes the runtime's status through rather than re-wording it", () => {
    const progress = LocalModelPull.readFrame({ status: "removing any unused layers" })
    if ("error" in progress) throw new Error("unexpected error frame")
    expect(progress.status).toBe("removing any unused layers")
  })
})

describe("Installed", () => {
  // Verbatim from the reference's `GET /api/tags` example.
  const entry = {
    name: "deepseek-r1:latest",
    model: "deepseek-r1:latest",
    modified_at: "2025-05-10T08:06:48.639712648-07:00",
    size: 4683075271,
    digest: "0a8c266910232fd3291e71e5ba1e058cc5af9d411192cf88b6d30e92b6e73163",
    details: { format: "gguf", family: "qwen2", parameter_size: "7.6B", quantization_level: "Q4_K_M" },
  }

  test("decodes through the real schema, keeping the size the fit check needs", () => {
    const decoded = Schema.decodeUnknownSync(LocalModelPull.Installed)(entry)
    expect(decoded.name).toBe("deepseek-r1:latest")
    expect(decoded.size).toBe(4683075271)
    expect(decoded.digest).toBe(entry.digest)
  })

  test("the size feeds the fit check as bytes, not as anything else", () => {
    // 4.68 GB of weights, so the requirement is that plus headroom -- which is what makes a
    // 4 GiB machine the wrong machine for it. The two modules meet exactly here.
    const decoded = Schema.decodeUnknownSync(LocalModelPull.Installed)(entry)
    const verdict = LocalModelFit.fit({
      modelBytes: decoded.size,
      hardware: {
        platform: "linux",
        arch: "x64",
        cores: 8,
        totalBytes: 4 * 1024 ** 3,
        availableBytes: 3 * 1024 ** 3,
      },
    })
    if (verdict.kind !== "short") throw new Error("a 4 GiB machine should not fit a 4.68 GB model")
    expect(verdict.constraint).toBe("memory")
    expect(verdict.requiredBytes).toBe(LocalModelFit.requirementFor(4683075271))
  })

  test("an entry with no size is dropped rather than treated as free", () => {
    // A model of unknown size that defaulted to zero would pass every fit check and then be
    // killed mid-load. Refusing to decode it is the honest outcome.
    expect(Schema.decodeUnknownOption(LocalModelPull.Installed)({ name: "x" })._tag).toBe("None")
  })
})
