import { useEffect, useMemo, useReducer, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Alert, Badge, Button, Card, EmptyState, Progress, TaskStatus, Textarea } from "@redrob-labs/ui"
import type { BuildoffCandidate, BuildoffMessage, BuildoffResult, BuildoffReveal } from "@redrob-code/desktop/bridge"
import { useT } from "../i18n"
import { initialRun, matrix, progress, reduce, type RunState } from "../lib/buildoff"
import { parseUnifiedDiff } from "../lib/diff"

/**
 * The blind build-off: describe a task, watch rival builders work in lanes A, B, C, read the evidence
 * and the judges' verdict, choose, and only then see which model built what.
 */
export function BuildOff(props: { directory: string }) {
  const t = useT()
  const bridge = window.redrobCode!
  const [task, setTask] = useState("")
  const [builders, setBuilders] = useState(3)
  const [budget, setBudget] = useState(5)
  const [run, dispatch] = useReducer(
    (
      state: RunState | null,
      action: { type: "start"; runId: string } | { type: "message"; message: BuildoffMessage } | { type: "reset" },
    ) => {
      if (action.type === "start") return initialRun(action.runId)
      if (action.type === "reset") return null
      return state ? reduce(state, action.message) : state
    },
    null,
  )
  const [startError, setStartError] = useState<string | null>(null)
  const past = useQuery({
    queryKey: ["buildoffs", props.directory],
    queryFn: () => bridge.buildoff.history(props.directory),
  })

  useEffect(() => bridge.buildoff.onMessage((message) => dispatch({ type: "message", message })), [bridge])
  useEffect(() => {
    if (run?.result) void past.refetch()
  }, [run?.result])

  const start = async () => {
    setStartError(null)
    try {
      const { runId } = await bridge.buildoff.start({ directory: props.directory, task, builders, budgetUsd: budget })
      dispatch({ type: "start", runId })
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error))
    }
  }

  if (run?.result)
    return <Verdict directory={props.directory} result={run.result} onDone={() => dispatch({ type: "reset" })} />

  if (run) {
    return (
      <div className="rc-stack">
        <div className="rc-row rc-between">
          <TaskStatus
            state={run.error ? "failed" : "running"}
            label={t(`buildoff.stage.${run.stage}` as never) || run.stage}
          />
          <Button size="sm" variant="ghost" onClick={() => void bridge.buildoff.cancel(run.runId)}>
            {t("buildoff.cancel")}
          </Button>
        </div>
        <Progress value={progress(run.stage)} label={t("buildoff.progress")} />
        {run.detail && <p className="rc-muted">{run.detail}</p>}
        {run.error && <Alert tone="danger">{run.error}</Alert>}
        <div className="rc-lanes">
          {run.lanes.map((lane) => (
            <Card key={lane.slot} title={`${t("buildoff.candidate")} ${lane.slot}`} padding="tight">
              <div className="rc-stack">
                <TaskStatus
                  state={laneState(lane.status)}
                  label={t(`buildoff.lane.${lane.status}` as never) || lane.status}
                />
                <span className="rc-muted">
                  {t("buildoff.tools", { count: lane.tools })} · ${lane.costUsd.toFixed(3)}
                </span>
              </div>
            </Card>
          ))}
        </div>
        {run.notes.map((note) => (
          <Alert key={note} tone="info">
            {note}
          </Alert>
        ))}
        {run.error && (
          <Button variant="secondary" onClick={() => dispatch({ type: "reset" })}>
            {t("buildoff.back")}
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="rc-stack rc-buildoff">
      <Card title={t("buildoff.title")} description={t("buildoff.intro")}>
        <div className="rc-stack">
          <Textarea
            value={task}
            rows={4}
            placeholder={t("buildoff.placeholder")}
            onChange={(event) => setTask(event.target.value)}
          />
          <div className="rc-row">
            <label className="rc-row">
              {t("buildoff.builders")}
              <select value={builders} onChange={(event) => setBuilders(Number(event.target.value))}>
                {[2, 3, 4, 5].map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
            <label className="rc-row">
              {t("buildoff.budget")}
              <select value={budget} onChange={(event) => setBudget(Number(event.target.value))}>
                {[1, 2, 5, 10, 20].map((value) => (
                  <option key={value} value={value}>
                    ${value}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="primary" disabled={!task.trim()} onClick={() => void start()}>
              {t("buildoff.start")}
            </Button>
          </div>
          {startError && <Alert tone="danger">{startError}</Alert>}
        </div>
      </Card>
      {(past.data ?? []).length > 0 && (
        <Card title={t("buildoff.history")}>
          <ul className="rc-list">
            {past.data!.slice(0, 10).map((entry) => (
              <li key={entry.id} className="rc-row rc-between">
                <span className="rc-ellipsis">{entry.task.split("\n")[0]}</span>
                <span className="rc-row">
                  <Badge
                    size="sm"
                    tone={
                      entry.status === "passed" ? "success" : entry.status === "below_standard" ? "warning" : "neutral"
                    }
                  >
                    {t(`buildoff.status.${entry.status}` as never) || entry.status}
                  </Badge>
                  {entry.revealed && entry.chosen && entry.models && (
                    <code className="rc-muted">{entry.models[entry.chosen]}</code>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function laneState(status: string): "queued" | "running" | "done" | "failed" | "stopped" {
  if (status === "preparing") return "queued"
  if (status === "building") return "running"
  if (status === "done") return "done"
  if (status === "cancelled") return "stopped"
  return "failed"
}

function Verdict(props: { directory: string; result: BuildoffResult; onDone: () => void }) {
  const t = useT()
  const bridge = window.redrobCode!
  const { result } = props
  const [open, setOpen] = useState<string | null>(result.winner)
  const [reveal, setReveal] = useState<BuildoffReveal | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [applied, setApplied] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const ordered = useMemo(
    () =>
      [...result.ranking, ...result.candidates.map((c) => c.slot).filter((slot) => !result.ranking.includes(slot))].map(
        (slot) => result.candidates.find((c) => c.slot === slot)!,
      ),
    [result],
  )
  const map = matrix(result)

  const choose = async (slot: string) => {
    setProblem(null)
    try {
      setReveal(await bridge.buildoff.pick(props.directory, result.id, slot))
      setChosen(slot)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }
  const applyAs = async (strategy: "branch" | "commit") => {
    setProblem(null)
    try {
      const done = await bridge.buildoff.apply(props.directory, result.id, strategy)
      setApplied(
        strategy === "branch"
          ? t("buildoff.appliedBranch", { branch: done.branch ?? "" })
          : t("buildoff.appliedCommit", { commit: done.commit.slice(0, 9) }),
      )
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="rc-stack">
      <Alert
        tone={result.status === "passed" ? "success" : result.status === "below_standard" ? "warning" : "danger"}
        title={t(`buildoff.status.${result.status}` as never)}
        action={
          <Button size="sm" variant="ghost" onClick={props.onDone}>
            {t("buildoff.new")}
          </Button>
        }
      >
        {result.neutral ? t("buildoff.neutral") : t("buildoff.notNeutral")} · ${result.costUsd.toFixed(3)}
      </Alert>

      <Card title={t("buildoff.gates")}>
        <ul className="rc-list">
          {result.gates.map((gate) => (
            <li key={gate.name} className="rc-row">
              <Badge size="sm" tone={gate.passed ? "success" : "danger"}>
                {gate.passed ? "✓" : "✗"} {t(`buildoff.gate.${gate.name}` as never) || gate.name}
              </Badge>
              <span className="rc-muted">{gate.detail}</span>
            </li>
          ))}
        </ul>
      </Card>

      <div className="rc-lanes">
        {ordered.map((candidate) => (
          <CandidateCard
            key={candidate.slot}
            candidate={candidate}
            recommended={candidate.slot === result.winner}
            selected={open === candidate.slot}
            reveal={reveal?.find((entry) => entry.slot === candidate.slot)}
            chosen={chosen === candidate.slot}
            canChoose={!reveal && candidate.changed}
            onOpen={() => setOpen(candidate.slot)}
            onChoose={() => void choose(candidate.slot)}
            onPreview={() =>
              void bridge.buildoff
                .preview(props.directory, result.id, candidate.slot)
                .catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)))
            }
          />
        ))}
      </div>

      {map.slots.length > 1 && (
        <Card title={t("buildoff.matrix")} description={t("buildoff.matrixHelp")}>
          <table className="rc-matrix">
            <thead>
              <tr>
                <th />
                {map.slots.map((slot) => (
                  <th key={slot}>{slot}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {map.slots.map((row) => (
                <tr key={row}>
                  <th>{row}</th>
                  {map.slots.map((column) => {
                    const value = map.cell(row, column)
                    return (
                      <td key={column} className={value ? `rc-matrix--${value}` : undefined}>
                        {value ? t(`buildoff.cell.${value}` as never) : "—"}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {problem && <Alert tone="danger">{problem}</Alert>}
      {reveal && !applied && (
        <Card title={t("buildoff.applyTitle")} description={t("buildoff.applyHelp")}>
          <div className="rc-row">
            <Button variant="primary" onClick={() => void applyAs("branch")}>
              {t("buildoff.applyBranch")}
            </Button>
            <Button variant="secondary" onClick={() => void applyAs("commit")}>
              {t("buildoff.applyCommit")}
            </Button>
          </div>
        </Card>
      )}
      {applied && <Alert tone="success">{applied}</Alert>}
      {open && <CandidateDiff directory={props.directory} contest={result.id} slot={open} />}
    </div>
  )
}

function CandidateCard(props: {
  candidate: BuildoffCandidate
  recommended: boolean
  selected: boolean
  reveal?: BuildoffReveal[number]
  chosen: boolean
  canChoose: boolean
  onOpen: () => void
  onChoose: () => void
  onPreview: () => void
}) {
  const t = useT()
  const c = props.candidate
  const checks = c.checks.length ? `${c.checks.filter((check) => check.passed).length}/${c.checks.length}` : "—"
  return (
    <Card
      title={`${t("buildoff.candidate")} ${c.slot}${props.reveal ? ` · ${props.reveal.model}` : ""}`}
      eyebrow={props.recommended ? t("buildoff.recommended") : undefined}
      variant={props.selected ? "raised" : "default"}
      padding="tight"
      footer={
        <div className="rc-row">
          <Button size="sm" variant="ghost" onClick={props.onOpen}>
            {t("buildoff.viewDiff")}
          </Button>
          <Button size="sm" variant="ghost" onClick={props.onPreview} disabled={!c.changed}>
            {t("buildoff.preview")}
          </Button>
          {props.canChoose && (
            <Button size="sm" variant={props.recommended ? "primary" : "secondary"} onClick={props.onChoose}>
              {t("buildoff.choose", { slot: c.slot })}
            </Button>
          )}
          {props.chosen && <Badge tone="success">{t("buildoff.chosen")}</Badge>}
        </div>
      }
    >
      <dl className="rc-facts">
        <dt>{t("buildoff.checks")}</dt>
        <dd>{checks}</dd>
        <dt>{t("buildoff.rivalTests")}</dt>
        <dd>{c.crossTests ? `${c.crossTests.passed}/${c.crossTests.total}` : "—"}</dd>
        <dt>{t("buildoff.quality")}</dt>
        <dd>
          {c.quality.score}
          {c.percentile !== null ? ` · p${Math.round(c.percentile)}` : ""}
        </dd>
        <dt>{t("buildoff.points")}</dt>
        <dd>{c.points}</dd>
        <dt>{t("buildoff.size")}</dt>
        <dd>
          <span className="rc-add">+{c.added}</span> <span className="rc-remove">−{c.removed}</span> · {c.files.length}
        </dd>
      </dl>
      {c.disqualified && <Alert tone="warning">{c.disqualified}</Alert>}
      {c.quality.components.length > 0 && (
        <ul className="rc-penalties">
          {c.quality.components.map((component) => (
            <li key={component.name}>
              −{component.penalty} {component.detail}
            </li>
          ))}
        </ul>
      )}
      {c.flags.map((flag) => (
        <p key={`${flag.file}${flag.detail}`} className="rc-danger">
          {flag.file}: {flag.detail}
        </p>
      ))}
    </Card>
  )
}

function CandidateDiff(props: { directory: string; contest: string; slot: string }) {
  const t = useT()
  const diff = useQuery({
    queryKey: ["buildoff-diff", props.contest, props.slot],
    queryFn: () => window.redrobCode!.buildoff.diff(props.directory, props.contest, props.slot),
  })
  if (!diff.data) return null
  const files = parseUnifiedDiff(diff.data)
  if (files.length === 0) return <EmptyState compact description={t("buildoff.noChange")} />
  return (
    <div className="rc-stack">
      <h3>
        {t("buildoff.candidate")} {props.slot}
      </h3>
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
