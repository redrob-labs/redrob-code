/**
 * Caller labels on `POST /v1/chat/completions`.
 *
 * A shared daemon serves several apps at once, so the app and session a request belongs to must
 * travel on the request, not in the engine's environment. The handler reads `x-redrob-app` and
 * `x-redrob-session` and forwards them to the provider under the same names the agent runner uses,
 * so the Console groups both paths the same way. Nothing else is forwarded.
 */
import { describe, expect, test } from "bun:test"
import { APP_HEADER, SESSION_HEADER, callerLabels } from "@redrob-code/server/handlers/chat-completion"

describe("chat completions caller labels", () => {
  test("app and session headers are forwarded under the runner's names", () => {
    expect(callerLabels({ [APP_HEADER]: "shape", [SESSION_HEADER]: "ses_1" })).toEqual({
      "x-redrob-app": "shape",
      "X-Session-Id": "ses_1",
      "x-session-affinity": "ses_1",
    })
  })

  test("absent or blank headers send nothing, and other headers are not forwarded", () => {
    expect(callerLabels({})).toEqual({})
    expect(callerLabels({ [APP_HEADER]: "  ", authorization: "Basic x", "x-forwarded-for": "1.2.3.4" })).toEqual({})
  })

  test("the app alone is enough", () => {
    expect(callerLabels({ [APP_HEADER]: " canvas " })).toEqual({ "x-redrob-app": "canvas" })
  })
})
