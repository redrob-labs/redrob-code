import { afterAll, beforeEach, describe, expect } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@redrob-code/core/effect/app-node-builder"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { EventV2 } from "@redrob-code/core/event"
import { Global } from "@redrob-code/core/global"
import { Location } from "@redrob-code/core/location"
import { LocationMutation } from "@redrob-code/core/location-mutation"
import { PermissionV2 } from "@redrob-code/core/permission"
import { AbsolutePath } from "@redrob-code/core/schema"
import { SessionV2 } from "@redrob-code/core/session"
import { ToolOutputStore } from "@redrob-code/core/tool-output-store"
import { ToolRegistry } from "@redrob-code/core/tool/registry"
import { ShareFileTool } from "@redrob-code/core/tool/share-file"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

const dir = mkdtempSync(path.join(os.tmpdir(), "share-file-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const assertions: PermissionV2.AssertInput[] = []
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => void assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const mutation = Layer.succeed(
  LocationMutation.Service,
  LocationMutation.Service.of({
    resolve: (input) => {
      const canonical = path.resolve(dir, input.path)
      return Effect.succeed({ canonical, resource: path.relative(dir, canonical), externalDirectory: undefined })
    },
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, EventV2.node, ShareFileTool.node]), [
    [PermissionV2.node, permission],
    [LocationMutation.node, mutation],
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(dir) }))),
    ],
    [Global.node, Global.layerWith({ data: Global.Path.data })],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ]),
)
const sessionID = SessionV2.ID.make("ses_share_file_test")

const share = (file: string) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const events = yield* EventV2.Service
    const published: EventV2.Payload[] = []
    const unsubscribe = yield* events.listen((event) => Effect.sync(() => void published.push(event)))
    const result = yield* executeTool(registry, {
      sessionID,
      ...toolIdentity,
      call: { type: "tool-call", id: "call-share", name: "share_file", input: { path: file } },
    })
    yield* unsubscribe
    return { result, attached: published.filter((event) => event.type === "session.next.attachment") }
  })

describe("ShareFileTool", () => {
  beforeEach(() => void (assertions.length = 0))

  it.effect("announces the file as an attachment and tells the model it was sent", () =>
    Effect.gen(function* () {
      writeFileSync(path.join(dir, "report.pdf"), "pdf")
      const { result, attached } = yield* share("report.pdf")
      expect(result).toEqual({ type: "text", value: "사용자에게 보냈어요: report.pdf" })
      expect(attached).toHaveLength(1)
      expect(attached[0]!.data).toMatchObject({
        sessionID,
        name: "report.pdf",
        mime: "application/pdf",
        size: 3,
        source: "share",
        path: path.join(dir, "report.pdf"),
      })
      // Same permission as read.
      expect(assertions).toMatchObject([{ action: "read", resources: ["report.pdf"] }])
    }),
  )

  it.effect("refuses a file over 10 MB", () =>
    Effect.gen(function* () {
      writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(ShareFileTool.MAX_SHARE_BYTES + 1))
      const { result, attached } = yield* share("big.bin")
      expect(result).toMatchObject({ type: "error" })
      expect(JSON.stringify(result)).toContain("over 10 MB")
      expect(attached).toEqual([])
    }),
  )

  it.effect("refuses env and key files", () =>
    Effect.gen(function* () {
      for (const name of [".env", ".env.local", "server.pem", "id.key", "AuthKey.p8", "release.jks", "id_rsa"]) {
        writeFileSync(path.join(dir, name), "secret")
        const { result, attached } = yield* share(name)
        expect(result).toMatchObject({ type: "error" })
        expect(attached).toEqual([])
      }
      expect(assertions.filter((item) => item.action === "read")).toEqual([])
      expect(ShareFileTool.isSecretFile(".env.example")).toBe(false)
    }),
  )

  it.effect("refuses a missing file", () =>
    Effect.gen(function* () {
      const { result, attached } = yield* share("nope.txt")
      expect(result).toMatchObject({ type: "error" })
      expect(attached).toEqual([])
    }),
  )
})
