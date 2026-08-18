import { type Credential, Plugin } from '@opencode-ai/plugin'
import { authorize, exchange, refreshToken } from './auth.ts'
import {
  createStrippedStream,
  isInsecure,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform.ts'

const PLUGIN_ID = 'ex-machina.anthropic-auth'
const INTEGRATION_ID = 'anthropic'

// `methodID` is a branded `Integration.MethodID` at the type level (a
// compile-time-only tag — there's no runtime representation), so a plain
// string literal needs a cast to satisfy the branded field.
const METHOD_ID = 'claude-max' as Credential.OAuth['methodID']

function toCredential(exchanged: {
  refresh: string
  access: string
  expires: number
}): Credential.OAuth {
  return {
    type: 'oauth',
    methodID: METHOD_ID,
    refresh: exchanged.refresh,
    access: exchanged.access,
    expires: exchanged.expires,
  }
}

// Shared in-flight refresh promise — prevents concurrent refresh calls from
// racing each other (and causing 401 cascades when the token server rotates
// the refresh token on every use).
let refreshInFlight: Promise<Credential.OAuth> | null = null

async function refreshCredential(
  credential: Credential.OAuth,
): Promise<Credential.OAuth> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const result = await refreshToken(credential.refresh)
      if (result.type === 'failed') {
        throw new Error(
          `Anthropic token refresh failed: ${result.status} — ${result.body}`,
        )
      }
      return toCredential(result)
    })().finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

async function resolveActiveOAuth(
  ctx: Plugin.Context,
): Promise<Credential.OAuth | undefined> {
  const connection = await ctx.integration.connection.active(INTEGRATION_ID)
  if (!connection) return undefined

  const credential = await ctx.integration.connection.resolve(connection)
  if (credential?.type === 'oauth' && credential.methodID === METHOD_ID) {
    return credential
  }

  return undefined
}

function warnIfInsecureUnsupported() {
  if (!isInsecure()) return
  console.warn(
    '[ex-machina.anthropic-auth] ANTHROPIC_INSECURE is set, but OpenCode v2 ' +
      'plugin request hooks cannot disable TLS verification for a custom ' +
      'ANTHROPIC_BASE_URL endpoint. TLS verification remains enabled — ' +
      'requests to an untrusted/self-signed endpoint will fail.',
  )
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup: async (ctx) => {
    warnIfInsecureUnsupported()

    await ctx.integration.transform((draft) => {
      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: METHOD_ID,
          type: 'oauth',
          label: 'Claude Pro/Max',
        },
        authorize: async () => {
          const result = await authorize('max')
          return {
            url: result.url,
            instructions: 'Paste the authorization code here:',
            mode: 'code',
            callback: async (code: string) => {
              const exchanged = await exchange(
                code,
                result.verifier,
                result.redirectUri,
                result.state,
              )
              if (exchanged.type === 'failed') {
                throw new Error(
                  'Failed to exchange the Claude Pro/Max authorization code. ' +
                    'Double-check that you pasted the full code and try again.',
                )
              }
              return toCredential(exchanged)
            },
          }
        },
        refresh: refreshCredential,
      })
    })

    // Zero out Anthropic model costs while our OAuth connection is active —
    // usage is covered by the Claude Pro/Max subscription, not billed per
    // token. Re-evaluated whenever the active connection changes.
    let oauthActive = Boolean(await resolveActiveOAuth(ctx))

    await ctx.catalog.transform((draft) => {
      if (!oauthActive) return
      const provider = draft.provider.get(INTEGRATION_ID)
      if (!provider) return
      for (const modelID of provider.models.keys()) {
        draft.model.update(INTEGRATION_ID, modelID, (model) => {
          model.cost = []
        })
      }
    })

    await ctx.session.hook('http.request', async (event) => {
      if (event.model.providerID !== INTEGRATION_ID) return
      const credential = await resolveActiveOAuth(ctx)
      if (!credential) return

      const request = event.request
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
      const bodyText = hasBody ? await request.clone().text() : undefined
      const rewrittenBody =
        bodyText !== undefined ? rewriteRequestBody(bodyText) : undefined

      const headers = mergeHeaders(request)
      setOAuthHeaders(headers, credential.access)

      const { input: rewrittenInput } = rewriteUrl(request.url)
      const url =
        typeof rewrittenInput === 'string'
          ? rewrittenInput
          : rewrittenInput instanceof Request
            ? rewrittenInput.url
            : rewrittenInput.toString()

      event.request = new Request(url, {
        method: request.method,
        headers,
        body: rewrittenBody,
        signal: request.signal,
      })
    })

    await ctx.session.hook('http.response', async (event) => {
      if (event.model.providerID !== INTEGRATION_ID) return
      const credential = await resolveActiveOAuth(ctx)
      if (!credential) return
      event.response = createStrippedStream(event.response)
    })

    // Keep the cached OAuth-active flag (and therefore the catalog cost
    // transform above) in sync with connection changes made outside of a
    // request — e.g. connecting/disconnecting via `/connect`.
    const abortController = new AbortController()
    ;(async () => {
      try {
        for await (const busEvent of ctx.event.subscribe({
          signal: abortController.signal,
        })) {
          if (
            busEvent.type !== 'integration.connection.updated' ||
            busEvent.data.integrationID !== INTEGRATION_ID
          ) {
            continue
          }

          const wasActive = oauthActive
          oauthActive = Boolean(await resolveActiveOAuth(ctx))
          if (wasActive !== oauthActive) {
            await ctx.catalog.reload()
          }
        }
      } catch (error) {
        if (!abortController.signal.aborted) throw error
      }
    })()

    return () => {
      abortController.abort()
    }
  },
})
