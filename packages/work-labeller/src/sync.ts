/*
 * Sends finished sessions to the Redrob Console, `POST <base>/insights/sessions`, with the person's
 * Redrob Key, in batches of 500. The person and workspace are the key's, so the console counts each
 * session as that person's work and nobody else's.
 *
 * Sessions the console accepted, updated or rejected leave the outbox: a rejection is permanent (an
 * old labeler, a label the console no longer accepts) and would only be refused again. Anything that
 * got no answer stays for the next run. Each app keeps its own outbox; this needs only list and remove.
 */
import type { LabeledSession } from "./labeler.js";

const BATCH = 500;

export interface SessionOutbox {
  list(): Promise<ReadonlyArray<{ session: LabeledSession }>>;
  remove(externalIds: readonly string[]): Promise<void>;
}

export type SyncDeps = {
  /** The Redrob Key, read when it is needed. Null when there is none. */
  readKey: () => Promise<string | null>;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** The console's API base, e.g. https://console.redrob.ai/api/backend/v1. */
  baseUrl: string;
};

export type SyncOutcome =
  | { status: "nothing" | "no-key" }
  | { status: "sent"; accepted: number; updated: number; rejected: number }
  | { status: "refused"; code: number }
  | { status: "unreachable" };

type IngestAnswer = { accepted?: unknown; updated?: unknown; rejected?: unknown };

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export async function syncOutbox(outbox: SessionOutbox, deps: SyncDeps): Promise<SyncOutcome> {
  const entries = await outbox.list();
  if (!entries.length) return { status: "nothing" };
  const key = await deps.readKey();
  if (!key) return { status: "no-key" };
  const base = deps.baseUrl.replace(/\/+$/, "");
  const totals = { accepted: 0, updated: 0, rejected: 0 };
  for (let start = 0; start < entries.length; start += BATCH) {
    const batch = entries.slice(start, start + BATCH).map((entry) => entry.session);
    let response: Response;
    try {
      response = await deps.fetch(`${base}/insights/sessions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sessions: batch }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return totals.accepted + totals.updated + totals.rejected ? { status: "sent", ...totals } : { status: "unreachable" };
    }
    if (!response.ok) return { status: "refused", code: response.status };
    const answer: IngestAnswer = await response.json().catch(() => ({}));
    totals.accepted += count(answer.accepted);
    totals.updated += count(answer.updated);
    totals.rejected += Array.isArray(answer.rejected) ? answer.rejected.length : 0;
    await outbox.remove(batch.map((session) => session.externalId));
  }
  return { status: "sent", ...totals };
}
