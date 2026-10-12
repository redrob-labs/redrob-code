import { RedrobCode } from "@redrob-code/client"
import { eligible, vendorOf, type Candidate, type ModelRef } from "./bench"

/**
 * The contest drives the engine only through its public session API, the same surface Redrob Cowork
 * and the desktop app use. Nothing here reaches into engine internals, so upstream changes to the
 * agent loop do not break the contest, and the contest can run against any engine it can reach.
 */

export type RunInput = {
  directory: string
  model: ModelRef
  text: string
  /** `build` for builders; `plan` for reviewers, which denies every edit tool. */
  agent?: string
  budgetUsd: number
  timeoutMs: number
  /** Permission actions answered "reject" instead of "once". */
  deny?: string[]
  onProgress?: (progress: { costUsd: number; tools: number; elapsedMs: number }) => void
}

export type RunOutput = {
  sessionID: string
  status: "done" | "over_budget" | "timeout" | "error"
  costUsd: number
  text: string
  error?: string
  tools: number
}

export interface Engine {
  models(directory: string): Promise<Candidate[]>
  run(input: RunInput): Promise<RunOutput>
}

export type Client = ReturnType<typeof RedrobCode.make>

export function connect(url: string, authorization?: string): Engine {
  const client = RedrobCode.make({
    baseUrl: url,
    headers: authorization ? { Authorization: authorization } : undefined,
  })
  return engineFromClient(client)
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

export function engineFromClient(client: Client): Engine {
  return {
    async models(directory) {
      const listed = await client.models.list({ location: { directory } })
      return listed.data
        .map((model) => ({
          providerID: model.providerID,
          id: model.id,
          name: model.name,
          tools: model.capabilities.tools,
          vendor: vendorOf({ providerID: model.providerID, id: model.id }),
        }))
        .filter(eligible)
    },

    async run(input) {
      const started = Date.now()
      const session = await client.sessions.create({
        location: { directory: input.directory },
        model: { id: input.model.id, providerID: input.model.providerID },
        ...(input.agent ? { agent: input.agent } : {}),
      })
      await client.sessions.prompt({ sessionID: session.id, prompt: { text: input.text } })

      const deny = new Set(input.deny ?? ["external_directory"])
      let costUsd = 0
      let tools = 0
      let idleTicks = 0
      let status: RunOutput["status"] = "done"
      let tick = 0

      while (true) {
        await sleep(tick < 10 ? 300 : 1000)
        tick++
        const pending = await client.permissions.list({ sessionID: session.id }).catch(() => [])
        for (const request of pending) {
          // A builder works unattended inside its own worktree: allow what it asks for there, refuse
          // anything that reaches outside it.
          await client.permissions
            .reply({
              sessionID: session.id,
              requestID: request.id,
              reply: deny.has(request.action) ? "reject" : "once",
            })
            .catch(() => {})
        }
        const active = await client.sessions.active().catch(() => ({}) as Record<string, unknown>)
        const running = Boolean((active as Record<string, unknown>)[session.id])
        let settled = false
        if (tick % 3 === 0 || !running) {
          const usage = await usageOf(client, session.id)
          costUsd = usage.costUsd
          tools = usage.tools
          settled = usage.settled
          input.onProgress?.({ costUsd, tools, elapsedMs: Date.now() - started })
        }
        if (costUsd > input.budgetUsd) {
          status = "over_budget"
          break
        }
        if (Date.now() - started > input.timeoutMs) {
          status = "timeout"
          break
        }
        // Finished means: not running, AND the newest message is a completed assistant reply, on two
        // readings in a row. Idle alone is not enough -- a prompt is admitted asynchronously, so a session
        // reads idle for a moment before its first turn starts, and between one step and the next.
        idleTicks = !running && settled ? idleTicks + 1 : 0
        if (idleTicks >= 2) break
      }
      if (status !== "done") await client.sessions.interrupt({ sessionID: session.id }).catch(() => {})

      const final = await usageOf(client, session.id)
      return {
        sessionID: session.id,
        status: final.error && status === "done" ? "error" : status,
        costUsd: final.costUsd,
        text: final.text,
        error: final.error,
        tools: final.tools,
      }
    },
  }
}

async function usageOf(client: Client, sessionID: string) {
  const messages = { data: await allMessages(client, sessionID) }
  let costUsd = 0
  let tools = 0
  let text = ""
  let error: string | undefined
  const last = messages.data.at(-1)
  const settled = last?.type === "assistant" && Boolean(last.time.completed)
  for (const message of messages.data) {
    if (message.type !== "assistant") continue
    costUsd += message.cost ?? 0
    const parts = message.content
    tools += parts.filter((part) => part.type === "tool").length
    const words = parts
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text)
      .join("\n")
    if (words.trim()) text = words
    error = message.error?.message
  }
  return { costUsd, tools, text, error, settled }
}

type Message = Awaited<ReturnType<Client["messages"]["list"]>>["data"][number]

/** Every message in a session, oldest first. The route serves at most 200 per page. */
async function allMessages(client: Client, sessionID: string): Promise<Message[]> {
  const result: Message[] = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const listed = await client.messages.list({ sessionID, order: "asc", limit: 200, cursor }).catch(() => null)
    if (!listed) break
    result.push(...listed.data)
    cursor = listed.cursor.next ?? undefined
    if (!cursor || listed.data.length === 0) break
  }
  return result
}
