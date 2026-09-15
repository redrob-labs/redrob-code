import { DialogSelect } from "../ui/dialog-select"
import { useLanguage } from "../context/language"
import { useDialog } from "../ui/dialog"

export function DialogLanguageList() {
  const language = useLanguage()
  const dialog = useDialog()

  return (
    <DialogSelect
      title={language.t("language.dialog.title")}
      options={language.locales.map((locale) => ({ title: language.label(locale), value: locale }))}
      current={language.locale()}
      onSelect={(option) => {
        language.set(option.value)
        dialog.clear()
      }}
    />
  )
}
