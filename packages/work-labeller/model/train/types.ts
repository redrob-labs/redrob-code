/** Training examples per kind of work, per language. Action keys are the console's (vocabulary.ts). */
export type TrainingRows = Record<string, { en: readonly string[]; ko: readonly string[] }>;
