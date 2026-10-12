/*
 * Folds engine facts into one tally per session, and hands each finished session to the outbox.
 *
 * A subagent runs in a session of its own, created with the session that started it as its parent.
 * Its facts are folded into that root session, which is the one the person sees and the one the
 * console counts: a run that started three subagents is one orchestrated session, not four.
 *
 * A session is finished when it has been quiet for `closeAfterMs` and nothing in it is running. The
 * tallies are held in memory only: after a restart a session in progress starts a new tally, which
 * loses part of that one session and nothing else.
 */
import type { WorkLabel } from "./classifier.js";
import type { Fact } from "./facts.js";
import { labelSession, type LabeledSession, type LabelingApp, type SessionTally } from "./labeler.js";

const MINUTE = 60_000;
/** A gap longer than this between an answer and the next message is the person away, not reading. */
const ATTENTION_CAP_MS = 10 * MINUTE;
const MAX_SESSIONS = 500;

type Live = {
  tally: SessionTally;
  userMessages: Set<string>;
  firstUserMessage: string | null;
  /** The first message went to the work classifier. */
  workRead: boolean;
  toolCalls: Set<string>;
  delegations: Set<string>;
  lastAnswerAt: number | null;
  /** Sessions in this tree running now, with when each started. */
  busySince: Map<string, number>;
  /** An abort waiting for the person's next message. */
  pendingRedirect: boolean;
};

export class SessionRecorder {
  private readonly roots = new Map<string, string>();
  private readonly live = new Map<string, Live>();

  constructor(
    private readonly app: LabelingApp,
    private readonly onFinished: (session: LabeledSession) => void | Promise<void>,
    private readonly closeAfterMs = 15 * MINUTE,
  ) {}

  private rootOf(sessionID: string): string {
    let current = sessionID;
    for (let depth = 0; depth < 16; depth += 1) {
      const parent = this.roots.get(current);
      if (!parent || parent === current) return current;
      current = parent;
    }
    return current;
  }

  private entry(root: string, at: number): Live {
    let found = this.live.get(root);
    if (!found) {
      found = {
        tally: {
          rootSessionID: root,
          startedAt: at,
          lastActivityAt: at,
          userTurns: 0,
          firstAttachedSource: false,
          assistantMessages: 0,
          toolCalls: 0,
          artifacts: 0,
          checks: 0,
          sends: 0,
          delegations: 0,
          peakConcurrentAgents: 0,
          subagentMinutes: 0,
          busyMinutes: 0,
          attentionMinutes: 0,
          permissionsAsked: 0,
          permissionsAlways: 0,
          aborted: 0,
          redirected: 0,
          sensitiveSends: 0,
          unmaskedSends: 0,
        },
        userMessages: new Set(),
        firstUserMessage: null,
        workRead: false,
        toolCalls: new Set(),
        delegations: new Set(),
        lastAnswerAt: null,
        busySince: new Map(),
        pendingRedirect: false,
      };
      this.live.set(root, found);
      while (this.live.size > MAX_SESSIONS) {
        const oldest = this.live.keys().next();
        if (oldest.done) break;
        this.live.delete(oldest.value);
      }
    }
    return found;
  }

  observe(fact: Fact): void {
    if (fact.kind === "session") {
      if (fact.parentID) this.roots.set(fact.sessionID, fact.parentID);
      return;
    }
    const root = this.rootOf(fact.sessionID);
    const isRoot = root === fact.sessionID;
    const live = this.entry(root, fact.at);
    const t = live.tally;
    t.lastActivityAt = Math.max(t.lastActivityAt, fact.at);

    switch (fact.kind) {
      case "user-turn": {
        // Messages inside a subagent are the agent instructing itself, not the person.
        if (!isRoot) return;
        if (!live.userMessages.has(fact.messageID)) {
          live.userMessages.add(fact.messageID);
          live.firstUserMessage ??= fact.messageID;
          t.userTurns += 1;
          if (t.userTurns === 1) t.startedAt = Math.min(t.startedAt, fact.at);
          if (live.lastAnswerAt !== null) {
            t.attentionMinutes += Math.min(ATTENTION_CAP_MS, Math.max(0, fact.at - live.lastAnswerAt)) / MINUTE;
          }
          if (live.pendingRedirect) {
            t.redirected += 1;
            live.pendingRedirect = false;
          }
        }
        if (fact.attachedSource && fact.messageID === live.firstUserMessage) t.firstAttachedSource = true;
        return;
      }
      case "assistant-done":
        if (isRoot) {
          t.assistantMessages += 1;
          live.lastAnswerAt = fact.at;
        }
        return;
      case "tool": {
        if (fact.status === "running") {
          if (fact.effect === "delegates" && !live.delegations.has(fact.callID)) {
            live.delegations.add(fact.callID);
            t.delegations += 1;
          }
          return;
        }
        if (live.toolCalls.has(fact.callID)) return;
        live.toolCalls.add(fact.callID);
        t.toolCalls += 1;
        if (fact.status !== "completed") return;
        if (fact.effect === "artifact") t.artifacts += 1;
        if (fact.effect === "checks") t.checks += 1;
        if (fact.effect === "sends") t.sends += 1;
        if (fact.effect === "delegates" && !live.delegations.has(fact.callID)) {
          live.delegations.add(fact.callID);
          t.delegations += 1;
        }
        return;
      }
      case "permission":
        if (fact.asked) t.permissionsAsked += 1;
        if (fact.reply === "always") t.permissionsAlways += 1;
        return;
      case "busy": {
        const since = live.busySince.get(fact.sessionID);
        if (fact.busy) {
          if (since === undefined) live.busySince.set(fact.sessionID, fact.at);
          const agents = [...live.busySince.keys()].filter((id) => id !== root).length;
          t.peakConcurrentAgents = Math.max(t.peakConcurrentAgents, agents);
          return;
        }
        if (since === undefined) return;
        live.busySince.delete(fact.sessionID);
        const minutes = Math.max(0, fact.at - since) / MINUTE;
        if (isRoot) t.busyMinutes += minutes;
        else t.subagentMinutes += minutes;
        return;
      }
      case "aborted":
        if (isRoot) {
          t.aborted += 1;
          live.pendingRedirect = true;
        }
        return;
      case "idle":
        if (live.busySince.has(fact.sessionID)) {
          this.observe({ kind: "busy", sessionID: fact.sessionID, at: fact.at, busy: false });
        }
        return;
    }
  }

  /**
   * From the privacy gate, not the engine: the plugin has no way to report this, so a fact sent to
   * the facts route can never claim a session was handled safely.
   */
  observeSensitivity(sessionID: string, at: number, unmasked: boolean): void {
    const root = this.rootOf(sessionID);
    const live = this.entry(root, at);
    live.tally.sensitiveSends += 1;
    if (unmasked) live.tally.unmaskedSends += 1;
  }

  /**
   * The first message's text, from the plugin, for the work classifier. Only a root session's first
   * message is read, once; the text is passed to `label` and not kept, and only the labels are.
   * Returns whether it was read.
   */
  async observeFirstMessage(
    sessionID: string,
    messageID: string,
    text: string,
    label: (text: string) => Promise<WorkLabel | null>,
  ): Promise<boolean> {
    const live = this.live.get(sessionID);
    if (!live || this.rootOf(sessionID) !== sessionID || live.firstUserMessage !== messageID || live.workRead) return false;
    live.workRead = true;
    const result = await label(text);
    live.tally.action = result?.action ?? null;
    live.tally.family = result?.family ?? null;
    return true;
  }

  /** Labels and hands over every session quiet for long enough. Returns how many were finished. */
  async sweep(now: number): Promise<number> {
    let finished = 0;
    for (const [root, live] of [...this.live]) {
      if (live.busySince.size > 0 || now - live.tally.lastActivityAt < this.closeAfterMs) continue;
      this.live.delete(root);
      // A session the person never wrote in (a subagent whose parent was missed, a restore) is nobody's work.
      if (live.tally.userTurns === 0) continue;
      await this.onFinished(labelSession(this.app, live.tally));
      finished += 1;
    }
    return finished;
  }

  /** For tests and the status endpoint: sessions being tallied now. */
  liveCount(): number {
    return this.live.size;
  }
}
