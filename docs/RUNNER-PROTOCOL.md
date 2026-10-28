# Agent runner protocol

How the engine talks to an agent runner: a local OpenAI-compatible provider whose "model" is a coding
CLI (Claude Code, Codex) that runs its own tools. The desktop app's shim
(redrob-desktop `apps/desktop/node-host/harness.mjs`) is the one runner today. The shapes below are the
ones redrob-desktop `apps/desktop/src/v2/features/HARNESS-NEEDS.md` uses; nothing was changed from it.

## Final shapes

### Provider options

```jsonc
"provider": {
  "claude-code": {
    "npm": "@ai-sdk/openai-compatible",
    "options": {
      "baseURL": "http://127.0.0.1:<port>/v1",
      "providerExecutedTools": true, // read runner tool calls from the stream (below)
      "agentRunner": true            // no title/summary run on this model
    }
  }
}
```

Either flag marks the provider as a runner for `x-redrob-directory`.

### Request headers (engine to runner)

| Header | Value |
| --- | --- |
| `x-session-affinity`, `X-Session-Id` | engine session id |
| `x-redrob-directory` | the session's folder, `encodeURIComponent`-encoded. Sent only to runner providers. |
| `x-parent-session-id` | parent session id, for a subagent session |

### Tools the runner ran (runner to engine, in the stream)

One `tool_calls` delta per finished CLI tool call, in a normal chat-completions chunk:

```json
{
  "choices": [{
    "index": 0,
    "delta": {
      "tool_calls": [{
        "index": 0,
        "id": "runner_<cli id>",
        "type": "function",
        "function": { "name": "bash", "arguments": "{\"command\":\"ls\"}" },
        "provider_executed": true,
        "title": "ls",
        "result": { "output": "a\nb\n" }
      }]
    }
  }]
}
```

- `result` is `{ "output": string }` or `{ "error": string }`.
- `function.arguments` is a JSON string (an object is accepted too).
- Each call needs its own `index` and a unique `id`; send the whole call in one delta.
- Use `finish_reason: "stop"`, not `"tool_calls"`.
- The engine stores each as a `tool` part of the assistant message (`state.status` `completed` or
  `error`, `metadata.providerExecuted: true`) and runs nothing locally. A call shows once it has
  finished.
- Engine side: `packages/redrob/src/session/llm/runner-tools.ts`.

Not replayed: on later turns the runner's own calls are left out of the prompt the engine sends back,
so the history has no `tool_calls` without tool messages.

### Approval mid-turn (runner to engine)

```
POST /session/:sessionID/permission
{ "permission": "bash", "patterns": ["git push"], "metadata": { ... }, "always": ["git push"] }

200 { "reply": "once" | "always" | "reject", "message"?: string }
```

- The engine finds the session's folder from the id in the path; no directory header is needed.
- Blocks until the person answers the session's permission card.
- `metadata` and `always` are optional. `always` defaults to `patterns`: the patterns an "always"
  answer allows for the rest of the session.
- The session's own permission rules and earlier "always" answers apply: an allowed pattern returns
  `"always"` at once, a denied one returns `"reject"` with a `message`.
- A reject with feedback typed by the person returns it as `message`.
- Closing the HTTP request drops the pending request.
- The request carries `metadata.runner: true` unless the runner sets `metadata.runner` itself.
- Permission names are the engine's tool names (`bash`, `edit`, `write`, `read`, `webfetch`, ...);
  patterns are the command or the file paths.

### Titles and summaries

- A chat on an `agentRunner` provider is titled after the first line of its first message; no model
  call is made for it (unless the `title` agent names its own model).
- Compaction is not skipped. It fires automatically only when the runner reports token usage that
  crosses the threshold; a runner that reports none is compacted only when the person asks. That
  request arrives without tools, and the shim answers it as a read-only side request.

### Not done

- `x-redrob-turn` (telling a retry from a new turn) is not sent; the shim does not need it for
  correctness.
