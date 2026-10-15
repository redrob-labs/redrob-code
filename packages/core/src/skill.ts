export * as SkillV2 from "./skill"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Result, Schema, Types } from "effect"
import { Skill } from "@redrob-code/schema/skill"
import { AgentV2 } from "./agent"
import { ConfigMarkdown } from "./config/markdown"
import { FSUtil } from "./fs-util"
import { PermissionV2 } from "./permission"
import { AbsolutePath } from "./schema"
import { SkillDiscovery } from "./skill/discovery"
import { State } from "./state"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = typeof Source.Type

export const Info = Skill.Info
export type Info = Skill.Info

export const AutoInject = Skill.AutoInject
export type AutoInject = Skill.AutoInject

export const available = (skills: ReadonlyArray<Info>, agent: AgentV2.Info) =>
  skills.filter((skill) => PermissionV2.evaluate("skill", skill.name, agent.permissions).effect !== "deny")

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
  icon: Schema.String.pipe(Schema.optional),
})
/**
 * `decodeUnknownResult`, not `decodeUnknownOption`: the Option form answers only "no", which
 * makes a malformed document unfindable among the ones that loaded. The Result form carries
 * the issue, so the log below can name the file AND why it was rejected.
 */
const decodeFrontmatter = Schema.decodeUnknownResult(Frontmatter)

/**
 * K-2's auto-arm block is decoded SEPARATELY from the rest of the frontmatter, so a
 * malformed `autoInject` costs only the arming behaviour: the skill still loads and stays
 * explicitly loadable, instead of the whole document being dropped for a typo in an
 * optional block.
 */
const decodeAutoInject = Schema.decodeUnknownResult(Skill.AutoInject)

/** The reason one document did not become a skill, kept so the log can say why. */
type Drop = { readonly file: string; readonly reason: string }

export type Data = {
  sources: Types.DeepMutable<Source>[]
}

export type Draft = {
  source: (source: Source) => void
  list: () => readonly Source[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@redrob/v2/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service

    const state = State.create<Data, Draft>({
      initial: () => ({ sources: [] }),
      draft: (draft) => ({
        source: (source) => {
          if (draft.sources.some((item) => Source.equals(item, source))) return
          draft.sources.push(source as Types.DeepMutable<Source>)
        },
        list: () => draft.sources as Source[],
      }),
    })

    const load = Effect.fn("SkillV2.load")(function* (source: Source) {
      const skills: Info[] = []
      if (source.type === "embedded") return [source.skill]
      const directories = source.type === "directory" ? [source.path] : yield* discovery.pull(source.url)
      // Decoded ONE DOCUMENT AT A TIME: a malformed frontmatter costs that document and not
      // the set, and every rejection is recorded with its reason so the cause is findable.
      const drops: Drop[] = []
      let ignoredAutoInject = 0
      for (const directory of directories) {
        const files = yield* fs
          .glob("{*.md,**/SKILL.md}", { cwd: directory, absolute: true, include: "file", symlink: true, dot: true })
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        for (const filepath of files.toSorted()) {
          const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!content) {
            drops.push({ file: filepath, reason: "unreadable: the file could not be read" })
            continue
          }
          const markdown = ConfigMarkdown.parseOption(content)
          if (!markdown) {
            drops.push({ file: filepath, reason: "unparsable: no valid markdown frontmatter block" })
            continue
          }
          const decoded = decodeFrontmatter(markdown.data)
          if (Result.isFailure(decoded)) {
            drops.push({ file: filepath, reason: `frontmatter rejected: ${decoded.failure.message}` })
            continue
          }
          const frontmatter = decoded.success
          const name =
            frontmatter.name !== undefined
              ? frontmatter.name
              : path.dirname(filepath) === directory
                ? path.basename(filepath, ".md")
                : undefined
          if (!name) {
            drops.push({
              file: filepath,
              reason: "unnamed: no `name` in frontmatter and the path gives no fallback name",
            })
            continue
          }
          // A malformed `autoInject` is IGNORED, not fatal: the skill loads and stays
          // explicitly loadable, which is what a skill without the block does anyway.
          let autoInject: AutoInject | undefined
          const declared = (markdown.data as Record<string, unknown> | undefined)?.["autoInject"]
          if (declared !== undefined) {
            const block = decodeAutoInject(declared)
            if (Result.isFailure(block)) {
              ignoredAutoInject += 1
              // The reason goes in the MESSAGE, not only in an annotation: the default logger
              // renders an annotation object as `[object Object]`, which loses exactly the
              // detail that makes this findable.
              yield* Effect.logWarning(
                `SkillV2.load ignored a malformed autoInject block in ${filepath} (skill "${name}"): ${block.failure.message}`,
              )
            } else autoInject = block.success
          }
          skills.push({
            name,
            description: frontmatter.description,
            slash: frontmatter.slash,
            icon: frontmatter.icon,
            autoInject,
            location: AbsolutePath.make(filepath),
            content: markdown.content,
          })
        }
      }
      if (drops.length > 0) {
        // Warning, not debug: a dropped skill is silently missing behaviour, so the count and
        // every individual reason have to reach a default log level to be findable at all.
        // Both are in the message text for the same reason the per-block warning above is.
        const total = skills.length + drops.length
        yield* Effect.logWarning(
          `SkillV2.load dropped ${drops.length} of ${total} skill documents from ${Source.key(source)} ` +
            `(loaded ${skills.length}, ignoredAutoInject ${ignoredAutoInject}): ` +
            drops.map((drop) => `${drop.file}: ${drop.reason}`).join("; "),
        )
      }
      return skills
    })

    // QUESTION(Dax): Should local skill sources invalidate on filesystem watch
    // events, following the reload policy chosen for other context sources?
    const cache = new Map<string, Info[]>()
    const list = Effect.fn("SkillV2.list")(function* () {
      const skills = new Map<string, Info>()
      for (const source of state.get().sources) {
        const key = Source.key(source)
        const loaded = cache.get(key) ?? (yield* load(source))
        cache.set(key, loaded)
        for (const skill of loaded) skills.set(skill.name, skill)
      }
      return Array.from(skills.values())
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().sources
      }),
      list,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: () => [SkillDiscovery.node, FSUtil.node] })
