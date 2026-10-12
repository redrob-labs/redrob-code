/*
 * @redrob-labs/route-labeller: label a request with its ModelGuide profession and task, on the
 * person's machine, for Redrob Auto to route on. Runtime-neutral; see node.ts for the filesystem and
 * download helpers.
 */
import lexicon from "./lexicon.json" with { type: "json" };
import manifest from "./manifest.json" with { type: "json" };
import prototypes from "./prototypes.json" with { type: "json" };

import type { Lexicon, Prototypes, RouteModelManifest } from "./types.js";

export const LEXICON = lexicon as Lexicon;
export const MANIFEST = manifest as RouteModelManifest;
export const PROTOTYPES = prototypes as Prototypes;

export { cosine, normalise, readDense, RouteModelIntegrityError, SentenceEncoder, sha256Hex } from "./encoder.js";
export type { EncoderFiles } from "./encoder.js";
export { canonicalProfession, labelLexically, scoreLexically } from "./lexical.js";
export type { CellScore } from "./lexical.js";
export { LABELLER_ID, LABELLER_VERSION, routeBody, RouteLabeller } from "./labeller.js";
export type { LabelOptions } from "./labeller.js";
export { catalogueIdOf, fetchGuide, guideLanguages, guideProfessions } from "./guide.js";
export type { GuideEditionPick, GuideEditionResponse, GuideKind, GuideLocale, GuidePick, GuideProfession } from "./guide.js";
export type { Lexicon, LexiconTerms, OrtRuntime, OrtSession, Prototypes, RouteLabel, RouteModelManifest } from "./types.js";
