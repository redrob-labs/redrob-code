export * as LocalModelPull from "./local-model-pull"

/**
 * Listing and fetching models from a local runtime.
 *
 * PA-8's other half. The engine already runs a local model once one is present -- a local
 * provider speaks the OpenAI wire protocol and `local-models.ts` lists what it serves. What
 * was missing is everything before that: what is on disk, how big, and getting one.
 *
 * WHY THIS IS A SECOND SET OF ROUTES. The OpenAI-compatible `GET /models` the provider
 * listing uses reports an id and nothing else -- no size. So it cannot answer the one
 * question PA-8 turns on, which is whether this machine can run the thing. Sizes and the
 * fetch itself live on the runtime's own API, so that is what this module speaks, and it is
 * gated by the same local-endpoint rule.
 *
 * WE DO NOT FETCH WEIGHTS OURSELVES. No picking a mirror, no choosing a quantisation, no
 * verifying a digest we chose to trust. The runtime already does all of it, resumes an
 * interrupted download, and shares progress between concurrent callers -- its own docs say
 * so. Re-implementing that would mean owning model provenance, which is a far larger
 * promise than "run a model locally".
 *
 * Shapes here come from the runtime's published API reference, not from reading our own
 * code back: `GET /api/tags` returns `models[].{name,size,digest,details}`, and
 * `POST /api/pull` streams `{status}` objects that carry `{digest,total,completed}` while
 * layers transfer. Two traps are documented there and both are handled below.
 */

import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

import { isLocalEndpoint } from "./local-provider"

/** Long, because a pull is a multi-gigabyte transfer and the caller is watching progress. */
const PULL_TIMEOUT = "6 hours"

/** Short, because listing what is already on disk is a local call that either answers or is down. */
const LIST_TIMEOUT = "2 seconds"

/**
 * One installed model. `size` is the field the whole fit check depends on.
 *
 * Decoded ONE AT A TIME by the caller, for the reason `local-models.ts` states: one entry
 * this build cannot describe should cost that entry, not the list.
 */
export const Installed = Schema.Struct({
  name: Schema.String,
  size: Schema.Finite,
  digest: Schema.optional(Schema.String),
})
export type Installed = Schema.Schema.Type<typeof Installed>

const TagList = Schema.Struct({ models: Schema.Array(Schema.Unknown) })

/**
 * One progress frame from a pull.
 *
 * `total` and `completed` are BOTH optional, and that is not defensive typing -- the
 * runtime's own docs say so. Status-only frames (`pulling manifest`, `verifying sha256
 * digest`, `writing manifest`, `success`) carry neither, and a downloading frame may carry
 * `total` without `completed` until the first bytes land.
 */
export const PullFrame = Schema.Struct({
  status: Schema.String,
  digest: Schema.optional(Schema.String),
  total: Schema.optional(Schema.Finite),
  completed: Schema.optional(Schema.Finite),
  error: Schema.optional(Schema.String),
})
export type PullFrame = Schema.Schema.Type<typeof PullFrame>

/** Progress as a caller should show it. */
export type Progress = {
  /** The runtime's own status line, passed through rather than re-worded. */
  readonly status: string
  /** Bytes transferred and expected FOR THE CURRENT LAYER, when the frame carries them. */
  readonly layerCompletedBytes?: number | undefined
  readonly layerTotalBytes?: number | undefined
  readonly done: boolean
}

/**
 * The runtime's own API lives at the ROOT, not under the OpenAI base path.
 *
 * A local runtime is configured with its OpenAI-compatible base, which is conventionally
 * `http://host:port/v1` -- that is the URL the provider needs and the one a user copies out
 * of the runtime's own banner. But `/api/tags` and `/api/pull` are siblings of `/v1`, not
 * children: joining them onto the configured base produces `/v1/api/tags`, which answers 404.
 *
 * Measured, not reasoned about. The first version joined onto the base, and against a server
 * serving the real `/api/tags` shape the command printed "answering, with nothing installed"
 * -- a wrong statement that looked like a working feature, because a 404 and an empty list
 * are both "no models" to a caller that does not separate them.
 */
const runtimeRoot = (base: string): string => base.replace(/\/+$/, "").replace(/\/v\d+$/, "")

export const tagsUrl = (base: string): string => `${runtimeRoot(base)}/api/tags`
export const pullUrl = (base: string): string => `${runtimeRoot(base)}/api/pull`

/**
 * Read one progress frame.
 *
 * A frame with an `error` is a failure the runtime is reporting in-band, mid-stream, with a
 * 200 already sent. Treated as terminal rather than as progress, because the alternative is
 * a pull that looks like it is still going and never finishes.
 */
export const readFrame = (frame: PullFrame): Progress | { readonly error: string } => {
  if (frame.error !== undefined && frame.error.length > 0) return { error: frame.error }
  return {
    status: frame.status,
    layerCompletedBytes: frame.completed,
    layerTotalBytes: frame.total,
    done: frame.status === "success",
  }
}

/**
 * Decode a newline-delimited stream body into frames, dropping only what fails.
 *
 * The runtime emits one JSON object per line and does not wrap them in an array, so a
 * whole-body parse never succeeds. A line that does not decode is skipped: these frames are
 * progress, and one unreadable frame must not abort a transfer that is working.
 */
export const readFrames = (body: string): ReadonlyArray<PullFrame> => {
  const frames: PullFrame[] = []
  for (const line of body.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      frames.push(Schema.decodeUnknownSync(PullFrame)(JSON.parse(trimmed)))
    } catch {
      continue
    }
  }
  return frames
}

/**
 * What is installed on this runtime, with sizes.
 *
 * Best-effort for the same reason the provider listing is: a local runtime that is not
 * running is the normal state of a laptop, not an error. A failed call returns an empty
 * list, and the caller distinguishes "nothing installed" from "no runtime" by asking
 * whether the runtime answered at all -- which is why `reachable` is returned separately
 * rather than inferred from an empty array.
 */
export const installed = Effect.fn("LocalModelPull.installed")(function* (base: string) {
  // Re-checked here rather than trusted from the caller, the same way `local-models.ts`
  // re-checks it: two independent checks of one rule means a later change that loosens one
  // cannot quietly turn this into a way to make the engine call an arbitrary host.
  if (!isLocalEndpoint(base)) return { reachable: false, models: [] as ReadonlyArray<Installed> }

  const client = yield* HttpClient.HttpClient
  const result = yield* client
    .execute(HttpClientRequest.get(tagsUrl(base)))
    .pipe(
      Effect.flatMap((response) => response.json),
      Effect.timeout(LIST_TIMEOUT),
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
  if (result === undefined) return { reachable: false, models: [] as ReadonlyArray<Installed> }

  const list = Schema.decodeUnknownOption(TagList)(result)
  if (list._tag === "None") return { reachable: true, models: [] as ReadonlyArray<Installed> }

  const models: Installed[] = []
  for (const entry of list.value.models) {
    const decoded = Schema.decodeUnknownOption(Installed)(entry)
    if (decoded._tag === "Some") models.push(decoded.value)
  }
  return { reachable: true, models }
})
