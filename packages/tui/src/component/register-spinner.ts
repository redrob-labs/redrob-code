import { getComponentCatalogue } from "@opentui/solid/components"
import { registerSpinner } from "opentui-spinner/solid"

export function registerRedrobSpinner() {
  if (!getComponentCatalogue().spinner) registerSpinner()
}
