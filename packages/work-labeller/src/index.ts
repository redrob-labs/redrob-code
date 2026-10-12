/*
 * @redrob-labs/work-labeller: labels an AI work session on the person's machine for the Redrob
 * Console's insights, the same way in Redrob Cowork, Office and Design. Only labels leave the machine.
 *
 * Runtime-neutral: no filesystem and no node:crypto. `./node` adds reading the model from a folder.
 */
export {
  createWorkClassifier,
  labelEmbedding,
  MANIFEST,
  meanPool,
  sha256OfBytes,
  WORK_FAMILIES,
  WORK_HEAD,
  WorkModelIntegrityError,
} from "./classifier.js";
export type { OrtRuntime, OrtSession, WorkClassifier, WorkFamily, WorkHead, WorkLabel, WorkModelManifest } from "./classifier.js";
export { parseFact } from "./facts.js";
export type { Fact, ToolEffect } from "./facts.js";
export { externalIdOf, labelSession, modeOf } from "./labeler.js";
export type { LabeledSession, LabelingApp, SessionTally } from "./labeler.js";
export { SessionRecorder } from "./recorder.js";
export { sha256Hex } from "./sha256.js";
export { syncOutbox } from "./sync.js";
export type { SessionOutbox, SyncDeps, SyncOutcome } from "./sync.js";
export { Unigram, unigramFromTokenizerJson } from "./unigram.js";
export type { UnigramOptions, UnigramPiece } from "./unigram.js";
export { ACTION_FAMILY, taskKey, WORK_ACTIONS, WORK_TASKS } from "./vocabulary.js";
