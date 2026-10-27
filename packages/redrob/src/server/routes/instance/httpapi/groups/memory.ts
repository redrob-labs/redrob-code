import { Memory } from "@/memory/memory"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ApiNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/memory"

export const AddPayload = Schema.Struct({
  kind: Memory.Kind,
  text: Schema.optional(Schema.String).annotate({ description: "Lesson: the rule" }),
  negative: Schema.optional(Schema.String).annotate({ description: "Lesson: what not to do" }),
  key: Schema.optional(Schema.String).annotate({ description: "Fact: the key" }),
  value: Schema.optional(Schema.String).annotate({ description: "Fact: the value" }),
  scope: Schema.optional(Schema.Literals(["global", "project"])).annotate({
    description: "global (default) or the current project only",
  }),
  repo: Schema.optional(Schema.String).annotate({ description: "Lesson: repo path fragment it applies to" }),
})

export const MemoryApi = HttpApi.make("memory")
  .add(
    HttpApiGroup.make("memory")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Memory.Entry), "Saved lessons and facts, newest first"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.list",
            summary: "List memory",
            description: "Get every saved lesson and fact, global and per project.",
          }),
        ),
        HttpApiEndpoint.post("add", root, {
          query: WorkspaceRoutingQuery,
          payload: AddPayload,
          success: described(Memory.Entry, "The saved entry"),
          error: [HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.add",
            summary: "Add memory",
            description: "Save a lesson or a fact. A fact with an existing key in the same scope is replaced.",
          }),
        ),
        HttpApiEndpoint.delete("remove", `${root}/:id`, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Entry removed"),
          error: [ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.remove",
            summary: "Remove memory",
            description: "Delete a saved lesson or fact by id.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "memory",
          description: "Lessons and facts carried across sessions.",
        }),
      )
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
