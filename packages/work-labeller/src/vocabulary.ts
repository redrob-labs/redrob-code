/*
 * The kinds of work and tasks a session can be labeled with, as the Redrob Console and Crew name
 * them (console `apps/api/src/insights/reference.ts`). Keys only: names and copy live in the console,
 * which is what shows them. A label outside this list is refused by the console, so the labeler and
 * the evaluation set both check against it.
 */

export const WORK_TASKS: Readonly<Record<string, readonly string[]>> = {
  reply: ["refund-request", "bug-report-reply", "how-to-answer", "escalation-response"],
  summ: ["ticket-thread-summary", "call-notes", "weekly-account-digest"],
  email: ["renewal-note", "cold-first-touch", "demo-follow-up"],
  research: ["account-brief", "competitor-scan"],
  analyze: ["pipeline-review", "churn-analysis", "forecast-check"],
  code: ["new-endpoint", "ui-component", "data-migration"],
  fix: ["failing-test", "production-incident"],
  review: ["pull-request-review"],
  test: ["unit-tests", "end-to-end-tests"],
  spec: ["product-spec", "project-plan"],
  design: ["ui-mockup", "marketing-visual"],
  copy: ["blog-post", "landing-page-copy", "social-post"],
  translate: ["korean-and-english-reply", "help-article"],
  policy: ["contract-review", "policy-draft"],
  hr: ["job-description", "review-summary", "onboarding-plan"],
  finance: ["month-end-reconciliation", "invoice-check"],
};

export const WORK_ACTIONS = Object.keys(WORK_TASKS);

/** The family each kind of work belongs to, as console `reference.ts` ACTIONS gives it. */
export const ACTION_FAMILY: Readonly<Record<string, "write" | "sheet" | "code" | "design">> = {
  reply: "write", summ: "write", email: "write", research: "write", spec: "write", copy: "write",
  translate: "write", policy: "write", hr: "write",
  analyze: "sheet", finance: "sheet",
  code: "code", fix: "code", review: "code", test: "code",
  design: "design",
};

/** The console's task key: `reply.refund-request`. */
export function taskKey(action: string, task: string): string {
  return `${action}.${task}`;
}
