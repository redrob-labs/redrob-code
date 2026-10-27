import { createMemo } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useLanguage } from "../context/language"

export type SettingItem = {
  id: string
  title: string
  description: string
  on: boolean
  toggle: () => void
}

// On/off switches that used to be separate palette commands. Picking a row flips it in place.
export function DialogSettings(props: { items: () => SettingItem[] }) {
  const language = useLanguage()
  const options = createMemo(() =>
    props.items().map((item) => ({
      title: item.title,
      value: item.id,
      description: item.description,
      footer: item.on ? language.t("settings.on") : language.t("settings.off"),
    })),
  )

  return (
    <DialogSelect
      title={language.t("settings.dialog.title")}
      options={options()}
      preserveSelection
      onSelect={(option) => {
        props
          .items()
          .find((item) => item.id === option.value)
          ?.toggle()
      }}
    />
  )
}
