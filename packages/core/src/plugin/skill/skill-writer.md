<!--
  K-5 built-in skill: the skill that writes skills. Its name, description and auto-arm block
  are registered in code at packages/core/src/plugin/skill.ts; the body below becomes the
  skill's content.

  The frontmatter template below is EXTRACTED from this file and round-tripped through the
  real loader by packages/core/test/skill/skill-writer.test.ts. It is not checked by eye, and
  it is not a copy of something checked elsewhere — that test reads this document. A key this
  loader does not accept, or a shape its decoder rejects, fails that test.
-->

# Writing a skill

A skill is one markdown file: a YAML frontmatter block that says what the skill is, and a
body that says what to do. Nothing registers it — the loader finds it by where it sits.

## Where the file goes

The loader globs `{*.md,**/SKILL.md}` under each skill directory, so exactly two layouts are
found and no others:

| layout | path | name comes from |
| --- | --- | --- |
| directory (prefer this) | `.redrob/skill/<skill-name>/SKILL.md` | frontmatter `name`, else nothing — a `SKILL.md` with no `name` is dropped |
| single file | `.redrob/skill/<skill-name>.md` | frontmatter `name`, else the filename without `.md` |

- Project scope: `.redrob/skill/` or `.redrob/skills/`.
- Global scope: `~/.config/redrob/skill/` or `~/.config/redrob/skills/`.

Use the directory layout and always write a `name`. A skill in a subdirectory whose
frontmatter has no `name` is dropped by the loader with an `unnamed:` reason, because the
path gives it no fallback — that is the single most common way a new skill silently fails to
appear.

Two skills with the same `name` collide and the later source wins. Check the existing names
before choosing one.

## The frontmatter

Only these keys are read. Anything else is ignored, so a misspelled key is not an error —
it is a skill that quietly does not do the thing you meant.

| key | type | effect |
| --- | --- | --- |
| `name` | string | the skill's identity. Write it. |
| `description` | string | when to use the skill. This is what the model reads to decide. |
| `slash` | boolean | expose it as a slash command. |
| `icon` | string | icon URL, for surfaces that list skills. |
| `autoInject.keywords` | string array | case-insensitive words matched against the prompt on word boundaries. |
| `autoInject.url` | string array | globs matched against the current tab URL. |

`autoInject` is what arms the skill without the user naming it. A skill with **no**
`autoInject` block never auto-arms and stays explicitly loadable — which is the right choice
for most skills. `autoInject: {}` with both lists absent also never arms: an empty list
matches nothing, deliberately, because a skill that arms on everything is a skill that is
always in the prompt.

A malformed `autoInject` costs only the arming. The skill still loads, and a warning names
the file and the reason. A malformed frontmatter block drops the whole document.

## The template

<!-- template:skill -->

```markdown
---
name: release-notes
description: Use when drafting release notes from a tag range, or when the user asks what changed between two versions.
slash: true
icon: https://code.redrob.ai/icon/release-notes.svg
autoInject:
  keywords:
    - release notes
    - changelog
  url:
    - github.com/*/releases/**
---

# Drafting release notes

State what the skill should do, in the order it should be done, and what to refuse.
Write for an agent that has the repository in front of it and no other context.
```

Copy that block, replace every value, delete the keys you do not need — `name` and
`description` are the two worth always keeping — and write it to the path chosen above.

## Writing the body

The body is the instruction, and it is read by an agent that has nothing else. So:

- Name the concrete surface: the file, the command, the global, the endpoint. Not "the
  relevant config".
- Say what to refuse and what to ask about, not only what to do.
- Every claim about a tool, a global or a flag must be true. A skill that describes a method
  that does not exist produces an agent that calls it and fails.
- Keep it short enough to be read whole. A skill is a page, not a manual.

## After writing

Skills are loaded when redrob starts and are not hot-reloaded. Tell the user to restart
redrob, then confirm the skill appears. If it does not, the frontmatter was rejected or the
file is outside a skill directory — the startup log names the file and the reason in both
cases.
