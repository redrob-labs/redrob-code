import { Routine } from "@redrob-code/schema/routine"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, RoutineNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/routine"

export const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionID: Schema.optional(SessionID),
})

export const RoutineApi = HttpApi.make("routine")
  .add(
    HttpApiGroup.make("routine")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: ListQuery,
          success: described(Schema.Array(Routine.Info), "Routines, oldest first"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "routine.list",
            summary: "List routines",
            description: "List routines, optionally only those of one session.",
          }),
        ),
        HttpApiEndpoint.post("create", root, {
          query: WorkspaceRoutingQuery,
          payload: Routine.CreateInput,
          success: described(Routine.Info, "The routine, already running"),
          error: [InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "routine.create",
            summary: "Create routine",
            description:
              "Start a routine in a session: an autopilot (after_turn), a schedule (cron or interval), or a watch on a GitHub pull request.",
          }),
        ),
        HttpApiEndpoint.get("get", `${root}/:routineID`, {
          params: { routineID: Routine.ID },
          query: WorkspaceRoutingQuery,
          success: described(Routine.Info, "The routine"),
          error: [RoutineNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({ identifier: "routine.get", summary: "Get routine", description: "Get one routine." }),
        ),
        HttpApiEndpoint.post("stop", `${root}/:routineID/stop`, {
          params: { routineID: Routine.ID },
          query: WorkspaceRoutingQuery,
          success: described(Routine.Info, "The stopped routine"),
          error: [RoutineNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "routine.stop",
            summary: "Stop routine",
            description: "Stop a routine for good, whatever wakes it. A turn already in flight finishes.",
          }),
        ),
        HttpApiEndpoint.post("pause", `${root}/:routineID/pause`, {
          params: { routineID: Routine.ID },
          query: WorkspaceRoutingQuery,
          success: described(Routine.Info, "The paused routine"),
          error: [RoutineNotFoundError, InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({ identifier: "routine.pause", summary: "Pause routine", description: "Pause a running routine." }),
        ),
        HttpApiEndpoint.post("resume", `${root}/:routineID/resume`, {
          params: { routineID: Routine.ID },
          query: WorkspaceRoutingQuery,
          success: described(Routine.Info, "The running routine"),
          error: [RoutineNotFoundError, InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "routine.resume",
            summary: "Resume routine",
            description: "Resume a paused or blocked routine. Approaches it already ruled out are kept.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "routine", description: "Routine routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "redrob HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )
