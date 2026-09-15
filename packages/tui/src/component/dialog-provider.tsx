import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useSync } from "../context/sync"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@redrob-code/sdk/v2"
import { DialogModel } from "./dialog-model"
import { useToast } from "../ui/toast"
import { isConsoleManagedProvider } from "../util/provider-origin"
import { useConnected } from "./use-connected"
import { useBindings } from "../keymap"
import { useClipboard } from "../context/clipboard"
import { useLanguage } from "../context/language"
import type { TuiI18nKey } from "../i18n"

const PROVIDER_PRIORITY: Record<string, number> = {
  redrob: 0,
  "redrob-go": 1,
  openai: 2,
  "github-copilot": 3,
  anthropic: 4,
  google: 5,
}

type ProviderOptionBase = {
  title: string
  value: string
  descriptionKey?: TuiI18nKey
  categoryKey: TuiI18nKey
}

type ProviderOption = ProviderOptionBase & {
  type: "provider"
  providerID: string
}

// Redrob Code connects to the Redrob console only, so there is no custom-provider entry: the
// list is the console-backed providers and nothing else.
export function providerOptions(list: { id: string; name: string }[]): ProviderOption[] {
  return pipe(
    list,
    sortBy(
      (x) => PROVIDER_PRIORITY[x.id] ?? 99,
      (x) => x.name.toLowerCase(),
      (x) => x.id,
    ),
    map((provider) => ({
      type: "provider" as const,
      title: provider.name,
      value: provider.id,
      providerID: provider.id,
      descriptionKey: (
        {
          redrob: "provider.description.redrob",
          anthropic: "provider.description.anthropic",
          openai: "provider.description.openai",
          "redrob-go": "provider.description.redrob_go",
        } as Record<string, TuiI18nKey | undefined>
      )[provider.id],
      categoryKey: (provider.id in PROVIDER_PRIORITY
        ? "provider.category.popular"
        : "provider.category.providers") satisfies TuiI18nKey as TuiI18nKey,
    })),
  )
}

export function createDialogProviderOptions() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const onboarded = useConnected()
  const language = useLanguage()

  const options = createMemo(() => {
    return pipe(
      providerOptions(sync.data.provider_next.all),
      map((provider) => {
        const providerID = provider.providerID
        const consoleManaged = isConsoleManagedProvider(sync.data.console_state.consoleManagedProviders, providerID)
        const connected = sync.data.provider_next.connected.includes(providerID)
        const methods: ProviderAuthMethod[] = sync.data.provider_auth[providerID] ?? [
          {
            type: "api",
            label: language.t("provider.auth.method.api"),
          },
        ]

        return {
          title: provider.title,
          value: provider.value,
          description: provider.descriptionKey ? language.t(provider.descriptionKey) : undefined,
          footer: consoleManaged ? sync.data.console_state.activeOrgName : undefined,
          category: language.t(provider.categoryKey),
          // DialogProvider skips the picker for a lone provider, but only when selecting it lands
          // somewhere: console-managed providers have nothing to enter, and anything other than a
          // single api method needs a choice made first.
          autoConnect: !consoleManaged && methods.length === 1 && methods[0].type === "api",
          gutter: connected && onboarded() ? () => <text fg={theme.success}>✓</text> : undefined,
          async onSelect() {
            if (consoleManaged) return

            let index: number | null = 0
            if (methods.length > 1) {
              index = await new Promise<number | null>((resolve) => {
                dialog.replace(
                  () => (
                    <DialogSelect
                      title={language.t("provider.auth.method.title")}
                      options={methods.map((x, index) => ({
                        title: x.label,
                        value: index,
                      }))}
                      onSelect={(option) => resolve(option.value)}
                    />
                  ),
                  () => resolve(null),
                )
              })
            }
            if (index == null) return
            const method = methods[index]
            if (method.type === "oauth") {
              let inputs: Record<string, string> | undefined
              if (method.prompts?.length) {
                const value = await PromptsMethod({
                  dialog,
                  prompts: method.prompts,
                })
                if (!value) return
                inputs = value
              }

              const result = await sdk.client.provider.oauth.authorize({
                providerID,
                method: index,
                inputs,
              })
              if (result.error) {
                toast.show({
                  variant: "error",
                  message: JSON.stringify(result.error),
                })
                dialog.clear()
                return
              }
              if (result.data?.method === "code") {
                dialog.replace(() => (
                  <CodeMethod providerID={providerID} title={method.label} index={index} authorization={result.data!} />
                ))
              }
              if (result.data?.method === "auto") {
                dialog.replace(() => (
                  <AutoMethod providerID={providerID} title={method.label} index={index} authorization={result.data!} />
                ))
              }
            }
            if (method.type === "api") {
              let metadata: Record<string, string> | undefined
              if (method.prompts?.length) {
                const value = await PromptsMethod({ dialog, prompts: method.prompts })
                if (!value) return
                metadata = value
              }
              return dialog.replace(() => (
                <ApiMethod providerID={providerID} title={method.label} metadata={metadata} />
              ))
            }
          },
        }
      }),
    )
  })
  return options
}

export function DialogProvider() {
  const language = useLanguage()
  const options = createDialogProviderOptions()
  // The Redrob console is the only provider, so a single-entry picker is pure friction: go
  // straight to its credential entry. The list still renders whenever there is a real choice.
  const only = createMemo(() => {
    const list = options()
    if (list.length !== 1) return
    if (!list[0].autoConnect) return
    return list[0]
  })
  onMount(() => {
    const single = only()
    if (single) void single.onSelect()
  })
  return (
    <Show when={!only()}>
      <DialogSelect title={language.t("provider.dialog.title")} options={options()} />
    </Show>
  )
}

interface AutoMethodProps {
  index: number
  providerID: string
  title: string
  authorization: ProviderAuthAuthorization
}
function AutoMethod(props: AutoMethodProps) {
  const language = useLanguage()
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const sync = useSync()
  const toast = useToast()
  const clipboard = useClipboard()

  useBindings(() => ({
    bindings: [
      {
        key: "c",
        desc: language.t("dialog.copy_code"),
        group: "Dialog",
        cmd: () => {
          const code =
            props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? props.authorization.url
          clipboard
            .write?.(code)
            .then(() => toast.show({ message: language.t("toast.copied_to_clipboard"), variant: "info" }))
            .catch(toast.error)
        },
      },
    ],
  }))

  onMount(async () => {
    const result = await sdk.client.provider.oauth.callback({
      providerID: props.providerID,
      method: props.index,
    })
    if (result.error) {
      toast.show({
        variant: "error",
        message:
          "name" in result.error && result.error.name === "ProviderAuthOauthCallbackFailed"
            ? language.t("provider.auth.oauth_failed")
            : JSON.stringify(result.error),
      })
      dialog.clear()
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.replace(() => <DialogModel providerID={props.providerID} />)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        <Link href={props.authorization.url} fg={theme.primary} />
        <text fg={theme.textMuted}>{props.authorization.instructions}</text>
      </box>
      <text fg={theme.textMuted}>{language.t("provider.auth.waiting")}</text>
      <text fg={theme.text}>
        c <span style={{ fg: theme.textMuted }}>{language.t("provider.auth.copy")}</span>
      </text>
    </box>
  )
}

interface CodeMethodProps {
  index: number
  title: string
  providerID: string
  authorization: ProviderAuthAuthorization
}
function CodeMethod(props: CodeMethodProps) {
  const language = useLanguage()
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const [error, setError] = createSignal(false)

  return (
    <DialogPrompt
      title={props.title}
      placeholder={language.t("provider.auth.code.placeholder")}
      onConfirm={async (value) => {
        const { error } = await sdk.client.provider.oauth.callback({
          providerID: props.providerID,
          method: props.index,
          code: value,
        })
        if (!error) {
          await sdk.client.instance.dispose()
          await sync.bootstrap()
          dialog.replace(() => <DialogModel providerID={props.providerID} />)
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>{props.authorization.instructions}</text>
          <Link href={props.authorization.url} fg={theme.primary} />
          <Show when={error()}>
            <text fg={theme.error}>{language.t("provider.auth.code.invalid")}</text>
          </Show>
        </box>
      )}
    />
  )
}

interface ApiMethodProps {
  providerID: string
  title: string
  metadata?: Record<string, string>
}
function ApiMethod(props: ApiMethodProps) {
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()

  return (
    <DialogPrompt
      title={props.title}
      placeholder={language.t("provider.auth.api.placeholder")}
      description={() =>
        ({
          redrob: (
            <box gap={1}>
              <text fg={theme.textMuted}>{language.t("provider.auth.redrob.description")}</text>
              <text fg={theme.text}>
                {language.t("provider.auth.redrob.link", { url: "https://console.redrob.ai" })}
              </text>
            </box>
          ),
          "redrob-go": (
            <box gap={1}>
              <text fg={theme.textMuted}>{language.t("provider.auth.redrob_go.description")}</text>
              <text fg={theme.text}>
                {language.t("provider.auth.redrob_go.link", { url: "https://code.redrob.ai/go" })}
              </text>
            </box>
          ),
        })[props.providerID] ?? undefined
      }
      onConfirm={async (value) => {
        if (!value) return
        await sdk.client.auth.set({
          providerID: props.providerID,
          auth: {
            type: "api",
            key: value,
            ...(props.metadata ? { metadata: props.metadata } : {}),
          },
        })
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        dialog.replace(() => <DialogModel providerID={props.providerID} />)
      }}
    />
  )
}

interface PromptsMethodProps {
  dialog: ReturnType<typeof useDialog>
  prompts: NonNullable<ProviderAuthMethod["prompts"]>[number][]
}
async function PromptsMethod(props: PromptsMethodProps) {
  const inputs: Record<string, string> = {}
  for (const prompt of props.prompts) {
    if (prompt.when) {
      const value = inputs[prompt.when.key]
      if (value === undefined) continue
      const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
      if (!matches) continue
    }

    if (prompt.type === "select") {
      const value = await new Promise<string | null>((resolve) => {
        props.dialog.replace(
          () => (
            <DialogSelect
              title={prompt.message}
              options={prompt.options.map((x) => ({
                title: x.label,
                value: x.value,
                description: x.hint,
              }))}
              onSelect={(option) => resolve(option.value)}
            />
          ),
          () => resolve(null),
        )
      })
      if (value === null) return null
      inputs[prompt.key] = value
      continue
    }

    const value = await new Promise<string | null>((resolve) => {
      props.dialog.replace(
        () => (
          <DialogPrompt title={prompt.message} placeholder={prompt.placeholder} onConfirm={(value) => resolve(value)} />
        ),
        () => resolve(null),
      )
    })
    if (value === null) return null
    inputs[prompt.key] = value
  }
  return inputs
}
