# Steering

Steering files are standing instructions for the agent, kept as markdown next to the code.

Where they are read from:

- `.redrob/steering/*.md` in the project
- `~/.config/redrob/steering/*.md` for every project
- `.kiro/steering/*.md` in the project and `~/.kiro/steering/*.md`, so Kiro steering works as is

When a file applies is set in its front matter. Without front matter it always applies.

```markdown
---
inclusion: always
---
Use pnpm, never npm.
```

```markdown
---
inclusion: fileMatch
fileMatchPattern: "src/api/**/*.ts"
---
Every handler validates its input with the shared schema.
```

```markdown
---
inclusion: manual
---
Release checklist: ...
```

| `inclusion` | Applies |
|---|---|
| `always` (default) | in every session's system prompt |
| `fileMatch` | when the agent reads a file matching `fileMatchPattern` (a glob from the project root, or a list) |
| `manual` | when you write `#<file name>` in a message, e.g. `#release` |
