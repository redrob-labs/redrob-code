/**
 * The one error both K-1's domain objects and K-3's document objects raise when the capability
 * itself is absent.
 *
 * It lives in its own module ON PURPOSE. `domain.ts` binds K-3's globals into `DOMAIN_GLOBALS`
 * at module scope, and `document.ts` needs this class — so importing it from `domain.ts` would
 * make the two modules a cycle whose evaluation order decides whether `DOCUMENT_GLOBALS` is
 * defined when `domain.ts` reads it. A leaf module has no such order to get wrong.
 */
import { Schema } from "effect"

/**
 * A domain object the running engine cannot reach. Carries the missing capability by name
 * so the model, the logs, and a person reading a transcript all see the same reason.
 */
export class DomainUnavailableError extends Schema.TaggedErrorClass<DomainUnavailableError>()(
  "CodeModeDomainUnavailable",
  { object: Schema.String, missing: Schema.String },
) {
  override get message() {
    return `The \`${this.object}\` domain object is not available in this session: ${this.missing}`
  }
}
