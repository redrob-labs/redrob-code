/**
 * K-1: the typed domain objects a skill document is written against.
 *
 * A skill is cheap only because these objects exist. Each one is a real TypeScript
 * interface with a single implementation, exported from this module and injected into the
 * Code Mode interpreter scope under its own name, so a skill body reads
 *
 *   const body = await page.text()
 *   await channel.send({ text: body.slice(0, 200) })
 *
 * rather than describing a tool call. Code Mode itself stays host-neutral: it is handed a
 * namespace of tools plus the list of names to bind as globals, and never learns what
 * `page` or `channel` mean (see packages/codemode/AGENTS.md).
 *
 * `page` has no implementation that can act today: nothing in the engine process controls
 * a browser page. Its single implementation is therefore `unavailablePage`, which THROWS a
 * message naming what is missing rather than returning a plausible value, so a skill
 * written against the interface fails loudly instead of silently reading an empty string.
 */
import { SessionV1 } from "@redrob-code/core/v1/session"
import { Effect, Schema } from "effect"
import { Tool as SandboxTool, toolError } from "@redrob-code/codemode"
import { PartID, type MessageID, type SessionID } from "../session/schema"
import type { Session } from "@/session/session"

/** One node returned by a page query. Kept to what a skill can act on without a handle. */
export interface PageNode {
  readonly selector: string
  readonly text: string
  readonly attributes: Readonly<Record<string, string>>
}

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

/**
 * The browser page the agent is acting in.
 *
 * Every method can fail with `DomainUnavailableError`, because whether a page exists is a
 * property of the session, not of the call.
 */
export interface Page {
  /** The page's current URL. */
  readonly url: () => Effect.Effect<string, DomainUnavailableError>
  /** The page's visible text. */
  readonly text: () => Effect.Effect<string, DomainUnavailableError>
  /** Nodes matching a CSS selector, in document order. */
  readonly query: (input: {
    readonly selector: string
    readonly limit?: number
  }) => Effect.Effect<ReadonlyArray<PageNode>, DomainUnavailableError>
  /** Clicks the first node matching a selector. */
  readonly click: (input: { readonly selector: string }) => Effect.Effect<void, DomainUnavailableError>
  /** Types text into the first node matching a selector, optionally submitting afterwards. */
  readonly type: (input: {
    readonly selector: string
    readonly text: string
    readonly submit?: boolean
  }) => Effect.Effect<void, DomainUnavailableError>
  /** Navigates the page and returns the URL actually landed on. */
  readonly navigate: (input: { readonly url: string }) => Effect.Effect<string, DomainUnavailableError>
}

/** The channel this session belongs to: where a message or a result is delivered. */
export interface Channel {
  /** Identifier of the conversation this session posts into. */
  readonly id: () => Effect.Effect<string, DomainUnavailableError>
  /** Posts a message visible to the person in the conversation. Returns the part id written. */
  readonly send: (input: { readonly text: string }) => Effect.Effect<string, DomainUnavailableError>
}

/**
 * The single `Page` implementation available in the engine process: none of it works.
 *
 * Kept deliberately rather than omitted, so the interface, the tool schemas, the generated
 * instructions, and the skills written against them all exist and are exercised before the
 * browser side lands. `missing` names the capability, not the symptom.
 */
export const unavailablePage = (
  missing = "the engine process has no browser-page control surface; the browser must expose page control to the engine first",
): Page => {
  const refuse = <A>() =>
    Effect.fail(new DomainUnavailableError({ object: "page", missing })) as Effect.Effect<A, DomainUnavailableError>
  return {
    url: () => refuse<string>(),
    text: () => refuse<string>(),
    query: () => refuse<ReadonlyArray<PageNode>>(),
    click: () => refuse<void>(),
    type: () => refuse<void>(),
    navigate: () => refuse<string>(),
  }
}

/**
 * The single `Channel` implementation: posts into the session the program is running in,
 * by appending a text part to the assistant message that owns the execution. Every surface
 * the session is attached to renders that part, so this is the channel in the sense the
 * skill means it, without the engine having to know which surface is attached.
 */
export const sessionChannel = (input: {
  readonly sessions: Session.Interface
  readonly sessionID: SessionID
  readonly messageID: MessageID
}): Channel => ({
  id: () => Effect.succeed(input.sessionID),
  send: ({ text }) =>
    Effect.gen(function* () {
      const part = yield* input.sessions.updatePart({
        id: PartID.ascending(),
        messageID: input.messageID,
        sessionID: input.sessionID,
        type: "text",
        text,
      } satisfies SessionV1.TextPart)
      return part.id
    }),
})

/**
 * A `Channel` that refuses. Used where the catalog is described rather than executed, so
 * the preview instructions list the same globals a real execution binds without a preview
 * being able to post anything into a conversation.
 */
export const unavailableChannel = (missing = "this is a catalog preview, not a live execution"): Channel => {
  const refuse = <A>() =>
    Effect.fail(new DomainUnavailableError({ object: "channel", missing })) as Effect.Effect<A, DomainUnavailableError>
  return { id: () => refuse<string>(), send: () => refuse<string>() }
}

const Empty = Schema.Struct({})

/** Narrow JSON projection of a page node, so results cross the sandbox data boundary. */
const PageNodeSchema = Schema.Struct({
  selector: Schema.String,
  text: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.String),
})

/**
 * Lifts a domain call into a Code Mode tool. A `DomainUnavailableError` becomes a
 * model-safe tool failure carrying the same sentence, so an unavailable object reads as a
 * precise refusal in the program rather than as an opaque execution failure.
 */
const lift =
  <I, A>(call: (input: I) => Effect.Effect<A, DomainUnavailableError>) =>
  (input: I) =>
    call(input).pipe(Effect.mapError((error) => toolError(error.message, error)))

/** `page` as a Code Mode namespace. The tool names are the interface's method names. */
export const pageTools = (page: Page) => ({
  url: SandboxTool.make({
    description: "Current URL of the page the agent is acting in.",
    input: Empty,
    output: Schema.String,
    run: lift(() => page.url()),
  }),
  text: SandboxTool.make({
    description: "Visible text of the current page.",
    input: Empty,
    output: Schema.String,
    run: lift(() => page.text()),
  }),
  query: SandboxTool.make({
    description: "Nodes matching a CSS selector, in document order.",
    input: Schema.Struct({
      selector: Schema.String.annotate({ description: "CSS selector." }),
      limit: Schema.optionalKey(Schema.Number.annotate({ description: "Maximum nodes to return." })),
    }),
    output: Schema.Array(PageNodeSchema),
    run: lift((input: { selector: string; limit?: number }) => page.query(input)),
  }),
  click: SandboxTool.make({
    description: "Click the first node matching a CSS selector.",
    input: Schema.Struct({ selector: Schema.String.annotate({ description: "CSS selector." }) }),
    output: Schema.Null,
    run: lift((input: { selector: string }) => page.click(input).pipe(Effect.as(null))),
  }),
  type: SandboxTool.make({
    description: "Type text into the first node matching a CSS selector.",
    input: Schema.Struct({
      selector: Schema.String.annotate({ description: "CSS selector." }),
      text: Schema.String.annotate({ description: "Text to type." }),
      submit: Schema.optionalKey(Schema.Boolean.annotate({ description: "Submit the field afterwards." })),
    }),
    output: Schema.Null,
    run: lift((input: { selector: string; text: string; submit?: boolean }) => page.type(input).pipe(Effect.as(null))),
  }),
  navigate: SandboxTool.make({
    description: "Navigate the page and return the URL landed on.",
    input: Schema.Struct({ url: Schema.String.annotate({ description: "Absolute URL to open." }) }),
    output: Schema.String,
    run: lift((input: { url: string }) => page.navigate(input)),
  }),
})

/** `channel` as a Code Mode namespace. */
export const channelTools = (channel: Channel) => ({
  id: SandboxTool.make({
    description: "Identifier of the conversation this session posts into.",
    input: Empty,
    output: Schema.String,
    run: lift(() => channel.id()),
  }),
  send: SandboxTool.make({
    description: "Post a message into the conversation this session belongs to.",
    input: Schema.Struct({ text: Schema.String.annotate({ description: "Message text." }) }),
    output: Schema.String,
    run: lift((input: { text: string }) => channel.send(input)),
  }),
})

/** The names bound as bare globals in the interpreter scope, in the order they are declared. */
export const DOMAIN_GLOBALS = ["channel", "page"] as const

/**
 * The domain namespaces for one execution, keyed by the global name each is bound to.
 * Returned as one object so the tool tree and `DOMAIN_GLOBALS` cannot drift apart.
 */
export const domainTools = (input: { readonly page: Page; readonly channel: Channel }) => ({
  channel: channelTools(input.channel),
  page: pageTools(input.page),
})
