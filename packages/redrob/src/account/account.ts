import { LayerNode } from "@redrob-code/core/effect/layer-node"
import { httpClient } from "@redrob-code/core/effect/app-node-platform"
import { Effect, Layer, Option, Context } from "effect"
import { serviceUse } from "@redrob-code/core/effect/service-use"
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http"

import { AccountRepo } from "./repo"
import { normalizeServerUrl } from "./url"
import {
  type AccountError,
  AccessToken,
  AccountID,
  Info,
  RefreshToken,
  AccountServiceError,
  AccountTransportError,
  Org,
  OrgID,
} from "./schema"

export {
  AccountID,
  type AccountError,
  AccountRepoError,
  AccountServiceError,
  AccountTransportError,
  AccessToken,
  RefreshToken,
  Info,
  Org,
  OrgID,
} from "./schema"

export type AccountOrgs = {
  account: Info
  orgs: readonly Org[]
}

export type ActiveOrg = {
  account: Info
  org: Org
}

const mapAccountServiceError =
  (message = "Account service operation failed") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, AccountError, R> =>
    effect.pipe(Effect.mapError((cause) => accountErrorFromCause(cause, message)))

const accountErrorFromCause = (cause: unknown, message: string): AccountError => {
  if (cause instanceof AccountServiceError || cause instanceof AccountTransportError) {
    return cause
  }

  if (HttpClientError.isHttpClientError(cause)) {
    switch (cause.reason._tag) {
      case "TransportError": {
        return AccountTransportError.fromHttpClientError(cause.reason)
      }
      default: {
        return new AccountServiceError({ message, cause })
      }
    }
  }

  return new AccountServiceError({ message, cause })
}

// The real console.redrob.ai API exposes no user/email/org concept. We derive a stable, non-secret
// account id from the key's `rrk_<prefix>` segment (falling back to the console host when the key is
// not in that shape) and use the console URL as the human-readable label.
const accountIdentity = (server: string, apiKey: string) => {
  const prefix = apiKey.match(/^(rrk_[^_]+)_/)?.[1]
  const host = new URL(server).host
  return {
    id: AccountID.make(prefix ? `redrob:${prefix}` : `redrob:${host}`),
    label: host,
  }
}

export interface Interface {
  readonly active: () => Effect.Effect<Option.Option<Info>, AccountError>
  readonly activeOrg: () => Effect.Effect<Option.Option<ActiveOrg>, AccountError>
  readonly list: () => Effect.Effect<Info[], AccountError>
  readonly orgsByAccount: () => Effect.Effect<readonly AccountOrgs[], AccountError>
  readonly remove: (accountID: AccountID) => Effect.Effect<void, AccountError>
  readonly use: (accountID: AccountID, orgID: Option.Option<OrgID>) => Effect.Effect<void, AccountError>
  readonly orgs: (accountID: AccountID) => Effect.Effect<readonly Org[], AccountError>
  readonly token: (accountID: AccountID) => Effect.Effect<Option.Option<AccessToken>, AccountError>
  // Validates an API key against the console and persists it as the account credential.
  readonly login: (url: string, apiKey: string) => Effect.Effect<AccountOrgs, AccountError>
}

export class Service extends Context.Service<Service, Interface>()("@redrob/Account") {}

export const use = serviceUse(Service)

const layer: Layer.Layer<Service, never, AccountRepo.Service | HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* AccountRepo.Service
    const http = yield* HttpClient.HttpClient
    // Key validation must not retry: a definitively rejected key (401/403) should fail immediately
    // instead of waiting through the transient backoff before login reports failure.
    const httpOk = HttpClient.filterStatusOk(http)

    const executeOk = (request: HttpClientRequest.HttpClientRequest) =>
      httpOk.execute(request).pipe(mapAccountServiceError("HTTP request failed"))

    // An API key does not expire or refresh; the stored access token is returned as-is.
    const resolveAccess = Effect.fnUntraced(function* (accountID: AccountID) {
      const maybeAccount = yield* repo.getRow(accountID)
      if (Option.isNone(maybeAccount)) return Option.none()

      const account = maybeAccount.value
      return Option.some({ account, accessToken: account.access_token })
    })

    const token = Effect.fn("Account.token")((accountID: AccountID) =>
      resolveAccess(accountID).pipe(Effect.map(Option.map((r) => r.accessToken))),
    )

    // The real API has no org concept; there are no remote orgs to enumerate.
    const orgs = Effect.fn("Account.orgs")((_accountID: AccountID) => Effect.succeed([] as readonly Org[]))

    const orgsByAccount = Effect.fn("Account.orgsByAccount")(function* () {
      const accounts = yield* repo.list()
      return accounts.map((account) => ({ account, orgs: [] as readonly Org[] }))
    })

    const activeOrg = Effect.fn("Account.activeOrg")(() => Effect.succeed(Option.none<ActiveOrg>()))

    const remove = Effect.fn("Account.remove")((accountID: AccountID) => repo.remove(accountID))

    const login = Effect.fn("Account.login")(function* (server: string, apiKey: string) {
      const normalizedServer = normalizeServerUrl(server)
      const accessToken = AccessToken.make(apiKey)
      const identity = accountIdentity(normalizedServer, apiKey)

      // Validate the key using the OpenAI-compatible models endpoint. The non-retrying client makes a
      // rejected key (401) fail immediately as an AccountServiceError instead of waiting on backoff.
      yield* executeOk(
        HttpClientRequest.get(`${normalizedServer}/api/backend/v1/models`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(accessToken),
        ),
      )

      yield* repo.persistAccount({
        id: identity.id,
        email: identity.label,
        url: normalizedServer,
        accessToken,
        orgID: Option.none(),
      })

      return {
        account: new Info({
          id: identity.id,
          email: identity.label,
          url: normalizedServer,
          active_org_id: null,
        }),
        orgs: [] as readonly Org[],
      }
    })

    return Service.of({
      active: repo.active,
      activeOrg,
      list: repo.list,
      orgsByAccount,
      remove,
      use: repo.use,
      orgs,
      token,
      login,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [AccountRepo.node, httpClient] })

export * as Account from "./account"
