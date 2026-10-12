import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Alert, Button, Composer, EmptyState, Message, TaskStatus } from "@redrob-labs/ui"
import type { MessagesListOutput } from "@redrob-code/client"
import { useEngine, useEngineEvents } from "../engine"
import { useT, type MessageKey } from "../i18n"
import { applyLiveEvent, changesMessages, describeToolInput, type LiveText } from "../lib/live"

type Item = MessagesListOutput["data"][number]
type Assistant = Extract<Item, { type: "assistant" }>
type Part = Assistant["content"][number]

/** One session's conversation: committed messages, text still streaming, pending permissions. */
export function Chat(props: { sessionID: string; busy: boolean }) {
  const t = useT()
  const { client } = useEngine()
  const queries = useQueryClient()
  const [live, setLive] = useState<LiveText>({})
  const [draft, setDraft] = useState("")
  const bottom = useRef<HTMLDivElement>(null)

  const messages = useQuery({
    queryKey: ["messages", props.sessionID],
    queryFn: () => client.messages.list({ sessionID: props.sessionID, order: "asc", limit: 500 }),
  })
  const permissions = useQuery({
    queryKey: ["permissions", props.sessionID],
    queryFn: () => client.permissions.list({ sessionID: props.sessionID }),
  })

  useEngineEvents((event) => {
    setLive((state) => applyLiveEvent(state, event, props.sessionID))
    if (changesMessages(event, props.sessionID)) {
      void queries.invalidateQueries({ queryKey: ["messages", props.sessionID] })
    }
    if (event.type.startsWith("permission.v2.") && event.data?.sessionID === props.sessionID) {
      void queries.invalidateQueries({ queryKey: ["permissions", props.sessionID] })
    }
  })

  const send = useMutation({
    mutationFn: (text: string) => client.sessions.prompt({ sessionID: props.sessionID, prompt: { text } }),
    onSuccess: () => setDraft(""),
  })
  const stop = useMutation({ mutationFn: () => client.sessions.interrupt({ sessionID: props.sessionID }) })
  const reply = useMutation({
    mutationFn: (input: { requestID: string; reply: "once" | "always" | "reject" }) =>
      client.permissions.reply({ sessionID: props.sessionID, ...input }),
    onSettled: () => void queries.invalidateQueries({ queryKey: ["permissions", props.sessionID] }),
  })

  const items = messages.data?.data ?? []
  const streaming = Object.entries(live).filter(([, text]) => text.length > 0)
  // A block body on purpose: recent Chromium returns a promise from scrollIntoView, and an effect that
  // returns anything but a function crashes React when the component unmounts.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" })
  }, [items.length, streaming.length])

  const error = send.error ?? stop.error ?? messages.error
  return (
    <div className="rc-chat">
      <div className="rc-chat__log" role="log" aria-live="polite">
        {items.length === 0 && !messages.isLoading && <EmptyState compact description={t("chat.empty")} />}
        {items.map((item) => (
          <ChatItem key={item.id} item={item} />
        ))}
        {streaming.map(([id, text]) => (
          <Message key={id} role="assistant">
            <p className="rc-pre">{text}</p>
          </Message>
        ))}
        {(permissions.data ?? []).map((request) => (
          <Alert
            key={request.id}
            tone="warning"
            title={t("permission.title")}
            action={
              <div className="rc-row">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => reply.mutate({ requestID: request.id, reply: "once" })}
                >
                  {t("permission.once")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => reply.mutate({ requestID: request.id, reply: "always" })}
                >
                  {t("permission.always")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => reply.mutate({ requestID: request.id, reply: "reject" })}
                >
                  {t("permission.reject")}
                </Button>
              </div>
            }
          >
            <code className="rc-ellipsis">
              {request.action} {request.resources.join(", ")}
            </code>
          </Alert>
        ))}
        <div ref={bottom} />
      </div>
      {error && <Alert tone="danger">{t("chat.error", { message: errorText(error) })}</Alert>}
      <Composer
        value={draft}
        onChange={setDraft}
        placeholder={t("chat.placeholder")}
        submitLabel={t("chat.send")}
        stopLabel={t("chat.stop")}
        busy={props.busy || send.isPending}
        status={props.busy ? <TaskStatus state="running" label={t("chat.working")} /> : undefined}
        onSubmit={(value) => {
          if (value.trim()) send.mutate(value.trim())
        }}
        onStop={() => stop.mutate()}
      />
    </div>
  )
}

function ChatItem(props: { item: Item }) {
  const { item } = props
  switch (item.type) {
    case "user":
      return (
        <Message role="user">
          <p className="rc-pre">{item.text}</p>
        </Message>
      )
    case "assistant":
      return (
        <Message role="assistant" footer={item.error ? item.error.message : undefined}>
          {item.content.map((part) => (
            <AssistantPart key={part.id} part={part} />
          ))}
        </Message>
      )
    case "shell":
      return (
        <Message role="system">
          <code>$ {item.command}</code>
          <pre className="rc-log">{item.output}</pre>
        </Message>
      )
    case "system":
    case "synthetic":
      return (
        <Message role="system">
          <p className="rc-pre rc-muted">{item.text}</p>
        </Message>
      )
    default:
      return null
  }
}

const TOOL_STATE: Record<string, { state: "queued" | "running" | "done" | "failed"; key: MessageKey }> = {
  pending: { state: "queued", key: "chat.tool.pending" },
  running: { state: "running", key: "chat.tool.running" },
  completed: { state: "done", key: "chat.tool.completed" },
  error: { state: "failed", key: "chat.tool.error" },
}

function AssistantPart(props: { part: Part }) {
  const t = useT()
  const { part } = props
  if (part.type === "text") return <p className="rc-pre">{part.text}</p>
  if (part.type === "reasoning") return null
  const status = TOOL_STATE[part.state.status] ?? TOOL_STATE["pending"]!
  return (
    <div className="rc-tool">
      <TaskStatus state={status.state} label={t(status.key)} />
      <code className="rc-tool__name">{part.name}</code>
      <span className="rc-ellipsis rc-muted">{describeToolInput(part.state.input)}</span>
      {part.state.status === "error" && <span className="rc-danger">{part.state.error.message}</span>}
    </div>
  )
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message)
  return String(error)
}
