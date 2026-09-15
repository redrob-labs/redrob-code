// @ts-nocheck

import { RedrobCode } from "@redrob-code/core"
import { ReadTool } from "@redrob-code/core/tools"

const redrob = RedrobCode.make({})

redrob.tool.add(ReadTool)

redrob.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

redrob.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

redrob.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await redrob.session.create({
  agent: "build",
})

redrob.subscribe((event) => {
  console.log(event)
})

await redrob.session.prompt({
  sessionID,
  text: "hey what is up",
})

await redrob.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await redrob.session.wait()

console.log(await redrob.session.messages(sessionID))
