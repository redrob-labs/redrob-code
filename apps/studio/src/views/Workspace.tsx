import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button, EmptyState, Tabs, TaskStatus } from "@redrob-labs/ui"
import { useEngine, useEngineEvents } from "../engine"
import { useT } from "../i18n"
import { BuildOff } from "./BuildOff"
import { Changes } from "./Changes"
import { Chat } from "./Chat"
import { Terminal } from "./Terminal"

type Tab = "buildoff" | "chat" | "changes" | "terminal"

/** One project folder: its sessions on the left, the selected session's chat, changes and terminal. */
export function Workspace(props: { directory: string }) {
  const t = useT()
  const { client } = useEngine()
  const queries = useQueryClient()
  const [sessionID, setSessionID] = useState<string | null>(null)
  // The build-off is the front door; sessions are one click away.
  const [tab, setTab] = useState<Tab>("buildoff")

  const sessions = useQuery({
    queryKey: ["sessions", props.directory],
    queryFn: () => client.sessions.list({ directory: props.directory, order: "desc", limit: 50 }),
  })
  const active = useQuery({ queryKey: ["sessions", "active"], queryFn: () => client.sessions.active() })
  useEngineEvents((event) => {
    if (event.type.startsWith("session.next.step.") || event.type === "session.next.prompted") {
      void queries.invalidateQueries({ queryKey: ["sessions"] })
    }
  })

  const create = useMutation({
    mutationFn: () => client.sessions.create({ location: { directory: props.directory } }),
    onSuccess: (session) => {
      setSessionID(session.id)
      setTab("chat")
      void queries.invalidateQueries({ queryKey: ["sessions", props.directory] })
    },
  })

  const list = sessions.data?.data ?? []
  const selected = sessionID ?? list[0]?.id ?? null

  return (
    <div className="rc-workspace">
      <section className="rc-sessions" aria-label={t("sessions.title")}>
        <div className="rc-row rc-between">
          <p className="rc-label">{t("sessions.title")}</p>
          <Button size="sm" variant="secondary" loading={create.isPending} onClick={() => create.mutate()}>
            {t("sessions.new")}
          </Button>
        </div>
        {list.length === 0 && !sessions.isLoading ? (
          <p className="rc-muted">{t("sessions.empty")}</p>
        ) : (
          <ul className="rc-list">
            {list.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className="rc-list__item"
                  aria-current={session.id === selected ? "page" : undefined}
                  onClick={() => setSessionID(session.id)}
                >
                  <span className="rc-ellipsis">{session.title || t("sessions.untitled")}</span>
                  {active.data?.[session.id] && <TaskStatus state="running" label={t("chat.working")} />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="rc-main">
        <Tabs
          variant="line"
          value={tab}
          onChange={(id) => setTab(id as Tab)}
          items={[
            { id: "buildoff", label: t("tabs.buildoff") },
            { id: "chat", label: t("tabs.chat") },
            { id: "changes", label: t("tabs.changes") },
            { id: "terminal", label: t("tabs.terminal") },
          ]}
        />
        <div className="rc-panel">
          {tab === "chat" &&
            (selected ? (
              <Chat key={selected} sessionID={selected} busy={Boolean(active.data?.[selected])} />
            ) : (
              <EmptyState
                title={t("sessions.empty")}
                action={
                  <Button variant="primary" onClick={() => create.mutate()}>
                    {t("sessions.new")}
                  </Button>
                }
              />
            ))}
          {tab === "buildoff" && <BuildOff directory={props.directory} />}
          {tab === "changes" && <Changes directory={props.directory} />}
          {tab === "terminal" && <Terminal directory={props.directory} />}
        </div>
      </section>
    </div>
  )
}
