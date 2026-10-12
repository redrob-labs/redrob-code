import { useQuery } from "@tanstack/react-query"
import { Alert, Badge, Button, EmptyState, Loader } from "@redrob-labs/ui"
import { useEngineEvents } from "../engine"
import { useT } from "../i18n"
import { parseUnifiedDiff } from "../lib/diff"

const TONE = { added: "success", untracked: "info", modified: "brand", deleted: "danger", renamed: "neutral" } as const

/** The project's working-tree changes against HEAD, refreshed whenever a tool finishes. */
export function Changes(props: { directory: string }) {
  const t = useT()
  const changes = useQuery({
    queryKey: ["git", props.directory],
    queryFn: () => window.redrobCode!.gitChanges(props.directory),
  })
  useEngineEvents((event) => {
    if (event.type === "session.next.tool.success" || event.type === "session.next.step.ended") void changes.refetch()
  })

  if (changes.isLoading) return <Loader label={t("changes.refresh")} />
  const data = changes.data
  if (!data) return <Alert tone="danger">{String(changes.error ?? "")}</Alert>
  if (!data.repository) return <EmptyState compact description={t("changes.notRepo")} />

  const files = parseUnifiedDiff(data.diff)
  return (
    <div className="rc-stack">
      <div className="rc-row rc-between">
        <Badge tone="neutral">{data.branch ?? "HEAD"}</Badge>
        <Button size="sm" variant="ghost" onClick={() => void changes.refetch()}>
          {t("changes.refresh")}
        </Button>
      </div>
      {data.files.length === 0 ? (
        <EmptyState compact description={t("changes.none", { branch: data.branch ?? "HEAD" })} />
      ) : (
        <ul className="rc-files">
          {data.files.map((file) => (
            <li key={file.path} className="rc-row">
              <Badge size="sm" tone={TONE[file.status]}>
                {file.status}
              </Badge>
              <code className="rc-ellipsis">{file.path}</code>
            </li>
          ))}
        </ul>
      )}
      {data.truncated && <Alert tone="info">{t("changes.truncated")}</Alert>}
      {files.map((file) => (
        <section key={file.path} className="rc-diff">
          <header className="rc-diff__head">
            <code>{file.path}</code>
            <span className="rc-add">+{file.additions}</span>
            <span className="rc-remove">−{file.deletions}</span>
          </header>
          <pre className="rc-diff__body">
            {file.lines.map((line, index) => (
              <div key={index} className={`rc-diff__line rc-diff__line--${line.kind}`}>
                {line.text || " "}
              </div>
            ))}
          </pre>
        </section>
      ))}
    </div>
  )
}
