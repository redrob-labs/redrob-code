export * as File from "./file"

import { Revert } from "@redrob-code/schema/revert"

export const Diff = Revert.FileDiff
export type Diff = typeof Diff.Type
