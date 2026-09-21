export * as Variant from "./variant"

import { Schema } from "effect"
import { optional } from "./schema"

/**
 * Asking several models the same thing, through the Redrob console.
 *
 * These are NOT OpenAI-standard endpoints, so they cannot arrive through the `@ai-sdk/openai-compatible`
 * path every other model call uses. They are exposed here instead, which keeps ONE implementation for the
 * three consumers that need it: the CLI's own commands, the desktop apps that read this server, and
 * anything else built on the SDK. A second client path would mean re-implementing credential resolution,
 * retries and error mapping, and those would drift.
 *
 * Available only while the Redrob provider is connected, because that is what the endpoints belong to. A
 * user on a local runtime or another vendor gets a plain 404 rather than a confusing failure inside a
 * request that could never have worked.
 */

/** A model to ask, and how hard to make it think. */
export const Model = Schema.Struct({
  model: Schema.String,
  variant: Schema.String.pipe(optional),
}).annotate({ identifier: "Variant.Model" })
export interface Model extends Schema.Schema.Type<typeof Model> {}

/**
 * What the console reports about serving one slot.
 *
 * `routedModel` is the load-bearing field and the reason this is passed through rather than summarised:
 * when the request names `auto`, it is the only thing that says which model actually answered. Without it
 * the most a client can tell a user is "Redrob Auto did it", which is not the transparency the feature is
 * for. `costUsd` is per slot, because one request here makes several charges.
 */
export const Provenance = Schema.Struct({
  requestId: Schema.String.pipe(optional),
  routedModel: Schema.String.pipe(optional),
  upstreamProvider: Schema.String.pipe(optional),
  latencyMs: Schema.Finite.pipe(optional),
  costUsd: Schema.Finite.pipe(optional),
}).annotate({ identifier: "Variant.Provenance" })
export interface Provenance extends Schema.Schema.Type<typeof Provenance> {}

/**
 * One slot's outcome.
 *
 * `text` and `error` are both optional and exactly one is expected, because the console runs the slots
 * under `Promise.allSettled`: a request can come back with some slots served and others failed. Modelling
 * that as an optional pair rather than a union keeps a partial result readable instead of forcing a client
 * to discard the slots that did work.
 */
export const Slot = Schema.Struct({
  slot: Schema.Int,
  model: Schema.String,
  text: Schema.String.pipe(optional),
  error: Schema.String.pipe(optional),
  redrob: Provenance.pipe(optional),
}).annotate({ identifier: "Variant.Slot" })
export interface Slot extends Schema.Schema.Type<typeof Slot> {}

export const Result = Schema.Struct({
  variants: Schema.Array(Slot),
  /** The sum the console already computed, so no client has to add the slots up itself. */
  totalCostUsd: Schema.Finite,
}).annotate({ identifier: "Variant.Result" })
export interface Result extends Schema.Schema.Type<typeof Result> {}

export const ParaphraseRequest = Schema.Struct({
  text: Schema.String,
  models: Schema.Array(Model),
  requestId: Schema.String.pipe(optional),
}).annotate({ identifier: "Variant.ParaphraseRequest" })
export interface ParaphraseRequest extends Schema.Schema.Type<typeof ParaphraseRequest> {}

export const Message = Schema.Struct({
  role: Schema.Literals(["system", "user", "assistant"]),
  content: Schema.String,
}).annotate({ identifier: "Variant.Message" })
export interface Message extends Schema.Schema.Type<typeof Message> {}

export const CompareRequest = Schema.Struct({
  messages: Schema.Array(Message),
  models: Schema.Array(Model),
  requestId: Schema.String.pipe(optional),
}).annotate({ identifier: "Variant.CompareRequest" })
export interface CompareRequest extends Schema.Schema.Type<typeof CompareRequest> {}
