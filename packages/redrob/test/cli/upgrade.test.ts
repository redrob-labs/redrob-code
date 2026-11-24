import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { Installation } from "../../src/installation"
import { launchStagedInstaller, upgrade } from "../../src/cli/upgrade"

afterEach(() => mock.restore())

// A Windows installer install upgraded from an open TUI: starting the setup right away let its
// /CLOSEAPPLICATIONS close the TUI mid-chat. The setup is downloaded now and started on the way out.
test("an open TUI stages the Windows setup and starts it only when it quits", async () => {
  spyOn(Installation, "method").mockResolvedValue("installer")
  spyOn(Installation, "latest").mockResolvedValue("999.0.0")
  spyOn(Installation, "getReleaseType").mockReturnValue("patch")
  const stage = spyOn(Installation, "stage").mockResolvedValue("C:\\Temp\\redrob-code-setup.exe")
  const now = spyOn(Installation, "upgrade").mockResolvedValue(undefined)

  await upgrade()

  expect(stage).toHaveBeenCalledTimes(1)
  expect(now).not.toHaveBeenCalled()

  const launched: string[] = []
  expect(launchStagedInstaller((file) => launched.push(file))).toBe("C:\\Temp\\redrob-code-setup.exe")
  expect(launched).toEqual(["C:\\Temp\\redrob-code-setup.exe"])
  // Once: a second shutdown call has nothing left to start.
  expect(launchStagedInstaller((file) => launched.push(file))).toBeUndefined()
  expect(launched).toHaveLength(1)
})
