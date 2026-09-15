import { DialogSelect } from "../../ui/dialog-select"
import { useRoute } from "../../context/route"
import { useLanguage } from "../../context/language"

export function DialogSubagent(props: { sessionID: string }) {
  const language = useLanguage()
  const route = useRoute()

  return (
    <DialogSelect
      title={language.t("session.dialog.subagent.title")}
      options={[
        {
          title: language.t("session.dialog.subagent.open_title"),
          value: "subagent.view",
          description: language.t("session.dialog.subagent.open"),
          onSelect: (dialog) => {
            route.navigate({
              type: "session",
              sessionID: props.sessionID,
            })
            dialog.clear()
          },
        },
      ]}
    />
  )
}
