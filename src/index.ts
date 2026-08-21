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

    // Keep refresh deduplication scoped to this plugin generation so a reload
    // cannot share stale credentials with the replacement instance.
    const refreshInFlight = new Map<string, Promise<Credential.OAuth>>()
    const refreshCredential = async (credential: Credential.OAuth) => {
      const existing = refreshInFlight.get(credential.refresh)
      if (existing) return existing

      const pending = (async () => {
        const result = await refreshToken(credential.refresh)
        if (result.type === 'failed') {
          throw new Error(`Anthropic token refresh failed: ${result.status}`)
        }
        return toCredential(result)
      })()
      refreshInFlight.set(credential.refresh, pending)
      try {
        return await pending
      } finally {
        if (refreshInFlight.get(credential.refresh) === pending) {
          refreshInFlight.delete(credential.refresh)
        }
      }
    }

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

    const transformedRequests = new WeakSet<Request>()

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
      transformedRequests.add(event.request)
    })

    await ctx.session.hook('http.response', (event) => {
      if (event.model.providerID !== INTEGRATION_ID) return
      if (!transformedRequests.delete(event.request)) return
      event.response = createStrippedStream(event.response)
    })
  },
})
