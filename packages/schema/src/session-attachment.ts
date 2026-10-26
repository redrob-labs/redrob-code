export * as SessionAttachment from "./session-attachment"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { SessionID } from "./session-id"

/**
 * A file the session put in front of the user: an image or PDF the read tool opened (`read`), or a
 * file the model handed over with `share_file` (`share`). Live only. The desk forwarder keeps the
 * ones it saw in memory and serves their bytes on `GET /desk/attachment/:sessionID/:id`, so a phone
 * or web chat can show and save them. `path` is the PC path, for display.
 */
export const ID = Schema.String.check(Schema.isStartsWith("att")).pipe(Schema.brand("SessionAttachment.ID"))
export type ID = typeof ID.Type
export const createID = () => ID.make("att_" + ascending())

export const Source = Schema.Literals(["read", "share"])
export type Source = typeof Source.Type

export const Info = Schema.Struct({
  sessionID: SessionID,
  id: ID,
  name: Schema.String,
  mime: Schema.String,
  size: Schema.Number,
  source: Source,
  path: Schema.String,
}).annotate({ identifier: "SessionAttachment.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

const Attached = define({ type: "session.next.attachment", schema: Info.fields })

export const Event = { Attached, Definitions: inventory(Attached) }
