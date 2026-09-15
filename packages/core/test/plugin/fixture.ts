import { AgentV2 } from "@redrob-code/core/agent"
import { AISDK } from "@redrob-code/core/aisdk"
import { Catalog } from "@redrob-code/core/catalog"
import { CommandV2 } from "@redrob-code/core/command"
import { Credential } from "@redrob-code/core/credential"
import { AppNodeBuilder } from "@redrob-code/core/effect/app-node-builder"
import { LayerNodePlatform } from "@redrob-code/core/effect/app-node-platform"
import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { EventV2 } from "@redrob-code/core/event"
import { FileSystem } from "@redrob-code/core/filesystem"
import { FSUtil } from "@redrob-code/core/fs-util"
import { Integration } from "@redrob-code/core/integration"
import { Location } from "@redrob-code/core/location"
import { Npm } from "@redrob-code/core/npm"
import { PluginV2 } from "@redrob-code/core/plugin"
import { Reference } from "@redrob-code/core/reference"
import { SkillV2 } from "@redrob-code/core/skill"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    EventV2.node,
    LayerNodePlatform.httpClient,
    PluginV2.node,
    AgentV2.node,
    AISDK.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    Reference.node,
    SkillV2.node,
  ]),
  [
    [Location.node, tempLocationLayer],
    [Npm.node, npmLayer],
  ],
)
