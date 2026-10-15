export * as ConfigPrivacy from "./privacy"

import { Schema } from "effect"

/**
 * PII masking: what leaves this machine inside a model request.
 *
 *   off    nothing is touched (the default -- the user turns it on).
 *   regex  emails, phone numbers, card numbers and Korean resident numbers are replaced by
 *          placeholders before any provider sees them, and put back in the answer.
 *   model  regex, plus a LOCAL model (one the engine already serves, e.g. an Ollama model) names
 *          people, organisations and places in the new text so those are replaced too.
 *
 * The engine does this in one place for every provider and every app that runs on it, so an app
 * only needs a switch, not its own masker.
 */
export const Mode = Schema.Literals(["off", "regex", "model"])
export type Mode = Schema.Schema.Type<typeof Mode>

export class Info extends Schema.Class<Info>("ConfigV2.Privacy")({
  mask_pii: Mode.pipe(Schema.optional).annotate({
    description: "Replace personal data with placeholders before a request leaves this machine",
  }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description: "For mask_pii = model: the LOCAL model that names people, organisations and places, as provider/model",
  }),
}) {}
