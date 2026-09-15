import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@redrob-code/core/workspace"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~redrob/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~redrob/WorkspaceRef", {
  defaultValue: () => undefined,
})
