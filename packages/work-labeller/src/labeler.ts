/*
 * Structural labels for one finished session: mode, outcome, craft flags that can be seen without
 * reading anything, and the agent figures. Pure, so every rule is a test away.
 *
 * The kind of work and its family come from the work classifier, which reads the first message on
 * this machine (classifier.ts); only the labels are kept. When it is unsure of the kind of work it
 * may still name the family alone. What it cannot tell yet is left out: the task within a kind of
 * work, whether the first message said what done looks like, and whether a session without a file
 * was a draft or an answer. So a session that only wrote
 * text in the chat is labeled as an answer (Look up or Learn), which undercounts drafts; it never
 * overcounts them.
 */
import type { WorkFamily } from "./classifier.js";
import { sha256Hex } from "./sha256.js";

/**
 * Which app is labeling, as the console knows it. A change of rules or model is a new
 * `labelerVersion`, so the console can show the boundary.
 */
export type LabelingApp = {
  /** A labeling tool of console `insights/reference.ts`: cowork, office, design. */
  toolKey: string;
  /** Starts every external id, so two apps never share one: `cw_`, `of_`, `dz_`. */
  idPrefix: string;
  labelerId: string;
  labelerVersion: string;
};

/** What the recorder accumulated for a session and every subagent session under it. */
export type SessionTally = {
  rootSessionID: string;
  startedAt: number;
  lastActivityAt: number;
  userTurns: number;
  /** The first message attached a file or pointed at one. */
  firstAttachedSource: boolean;
  assistantMessages: number;
  toolCalls: number;
  artifacts: number;
  checks: number;
  sends: number;
  delegations: number;
  /** Most delegated subagents running at the same moment. */
  peakConcurrentAgents: number;
  /** Minutes subagents spent running, all added up. */
  subagentMinutes: number;
  /** Minutes the root agent spent running. */
  busyMinutes: number;
  /** Minutes between an answer and the person's next message, each gap capped. */
  attentionMinutes: number;
  permissionsAsked: number;
  permissionsAlways: number;
  aborted: number;
  /** A message from the person within two messages after an abort: the run was redirected. */
  redirected: number;
  /** Sends to the model that carried something sensitive, from the privacy gate. */
  sensitiveSends: number;
  /** Of those, sends where something sensitive went out unmasked at the chat's level. */
  unmaskedSends: number;
  /** The work classifier's kind of work for the first message; absent when it named none or did not run. */
  action?: string | null;
  /** Its family: the kind of work's, or the classifier's alone when it was unsure of the kind. */
  family?: WorkFamily | null;
};

export type LabeledSession = {
  externalId: string;
  startedAt: string;
  toolKey: string;
  mode: number;
  producedOutput: boolean;
  brief: boolean;
  context: boolean;
  checked: boolean;
  steerApplicable: boolean;
  steered: boolean;
  outward: boolean;
  sensitiveTouched: boolean;
  sensitiveOk: boolean;
  turns: number;
  familyKey?: WorkFamily;
  actionKey?: string;
  agent?: {
    actions: number;
    instructions: number;
    agentMinutes: number;
    attentionMinutes: number;
    autoApproved: boolean;
    interrupted: boolean;
    agentsAtOnce: number;
    humanEquivHours: number;
  };
  labelerId: string;
  labelerVersion: string;
};

/**
 * The id the console knows a session by, and the value of x-redrob-session on its requests. A hash,
 * so the engine's own session id never leaves the machine; the same for the recorder and the plugin.
 */
export function externalIdOf(app: Pick<LabelingApp, "idPrefix">, rootSessionID: string): string {
  return `${app.idPrefix}${sha256Hex(rootSessionID).slice(0, 32)}`;
}

/** Tool calls per message from the person above which the agent did the work, not the person. */
const DELEGATED_STEPS_PER_TURN = 6;

/**
 * The mode, by Crew's definitions:
 *   5 Orchestrate: two or more agents at once.
 *   4 Delegate: one agent did the whole task, either a delegated subagent or the agent taking many
 *     steps on its own for each message, ending in something produced.
 *   3 Iterate: something produced over three or more messages.
 *   2 Draft: something produced in one or two messages.
 *   1 Learn: nothing produced, but a back and forth.
 *   0 Look up: one question, nothing produced.
 */
export function modeOf(t: SessionTally): number {
  const produced = t.artifacts > 0 || t.sends > 0;
  if (t.peakConcurrentAgents >= 2) return 5;
  const autonomous = produced && t.userTurns > 0 && t.toolCalls / t.userTurns >= DELEGATED_STEPS_PER_TURN;
  if ((t.delegations > 0 && produced) || autonomous) return 4;
  if (produced) return t.userTurns >= 3 ? 3 : 2;
  return t.userTurns >= 2 ? 1 : 0;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

export function labelSession(app: LabelingApp, t: SessionTally): LabeledSession {
  const mode = modeOf(t);
  const producedOutput = t.artifacts > 0 || t.sends > 0;
  const agent = mode >= 4;
  return {
    externalId: externalIdOf(app, t.rootSessionID),
    startedAt: new Date(t.startedAt).toISOString().replace(/\.\d+Z$/, "Z"),
    toolKey: app.toolKey,
    mode,
    producedOutput,
    // Needs the classifier, which reads the first message on this machine.
    brief: false,
    context: t.firstAttachedSource,
    checked: t.checks > 0,
    steerApplicable: t.aborted > 0 || (mode >= 3 && t.userTurns >= 3),
    steered: t.redirected > 0,
    outward: t.sends > 0,
    sensitiveTouched: t.sensitiveSends > 0,
    sensitiveOk: t.sensitiveSends > 0 && t.unmaskedSends === 0,
    turns: t.userTurns,
    ...(t.family ? { familyKey: t.family } : {}),
    ...(t.action ? { actionKey: t.action } : {}),
    ...(agent
      ? {
          agent: {
            actions: t.toolCalls,
            instructions: Math.max(1, t.userTurns),
            agentMinutes: round2(Math.min(100_000, t.subagentMinutes + t.busyMinutes)),
            attentionMinutes: round2(Math.min(100_000, t.attentionMinutes)),
            autoApproved: t.permissionsAsked === 0 || t.permissionsAlways > 0,
            interrupted: t.aborted > 0,
            agentsAtOnce: Math.min(64, Math.max(1, t.peakConcurrentAgents)),
            // Crew's "work done by agents" needs the kind of work's baseline; the console estimates it.
            humanEquivHours: 0,
          },
        }
      : {}),
    labelerId: app.labelerId,
    labelerVersion: app.labelerVersion,
  };
}
