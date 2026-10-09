export * as Insights from "./insights"

import { Schema } from "effect"
import { NonNegativeInt } from "./schema"

/**
 * Labeled AI work sessions, sent to the Redrob console's insights on an app's behalf.
 *
 * WHY THROUGH THE ENGINE. An app that keeps no credential of its own -- Office's rule is that it never
 * holds a provider key -- still has to send its labels with the person's Redrob key. The engine holds
 * that key, so the engine makes the call and the key never leaves it. The route takes no URL: the batch
 * goes to the console's fixed insights endpoint and nowhere else.
 *
 * A session is passed through as the app's object rather than re-declared here. The console owns the
 * shape (`POST /v1/insights/sessions` in redrob-console) and refuses any field that is not a label, so a
 * copy of that contract here would only drift from the one that decides. What this side bounds is the
 * batch: 1 to 500 sessions, the console's own limit.
 */

/** The most sessions the console takes in one request. */
export const MAX_SESSIONS = 500

export const SessionsRequest = Schema.Struct({
  sessions: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_SESSIONS),
  ),
}).annotate({ identifier: "Insights.SessionsRequest" })
export interface SessionsRequest extends Schema.Schema.Type<typeof SessionsRequest> {}

/** One session the console refused, with why. A refusal is permanent: sending it again is refused again. */
export const Rejection = Schema.Struct({
  externalId: Schema.String,
  reason: Schema.String,
}).annotate({ identifier: "Insights.Rejection" })
export interface Rejection extends Schema.Schema.Type<typeof Rejection> {}

/** What the console did with the batch, session by session. */
export const SessionsResult = Schema.Struct({
  accepted: NonNegativeInt,
  updated: NonNegativeInt,
  rejected: Schema.Array(Rejection),
}).annotate({ identifier: "Insights.SessionsResult" })
export interface SessionsResult extends Schema.Schema.Type<typeof SessionsResult> {}
