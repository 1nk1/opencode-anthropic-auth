import { type Credential, Plugin } from '@opencode-ai/plugin'
import { authorize, exchange, refreshToken } from './auth.ts'
import { BodyLimitError, contentLength, readBoundedText } from './bounded.ts'
import { REQUIRED_BETAS } from './constants.ts'
import {
  createStrippedStream,
  isTrustedAnthropicUrl,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform.ts'

const PLUGIN_ID = 'ink1.anthropic-auth'
const INTEGRATION_ID = 'anthropic'
const REFRESH_CACHE_GRACE_MS = 30_000
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024

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

function isTransformedOAuthRequest(request: Request): boolean {
  const betas = new Set(
    (request.headers.get('anthropic-beta') ?? '')
      .split(',')
      .map((beta) => beta.trim()),
  )
  return (
    request.headers.get('authorization')?.startsWith('Bearer ') === true &&
    REQUIRED_BETAS.every((beta) => betas.has(beta)) &&
    new URL(request.url).searchParams.get('beta') === 'true'
  )
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup: async (ctx) => {
    // Retain successful refreshes for this plugin generation so a host call
    // holding the rotated token cannot submit it again before persistence.
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
        const rotated = await pending
        const timer = setTimeout(() => {
          if (refreshInFlight.get(credential.refresh) === pending) {
            refreshInFlight.delete(credential.refresh)
          }
        }, REFRESH_CACHE_GRACE_MS)
        timer.unref?.()
        return rotated
      } catch (error) {
        if (refreshInFlight.get(credential.refresh) === pending) {
          refreshInFlight.delete(credential.refresh)
        }
        throw error
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

    await ctx.session.hook('http.request', async (event) => {
      if (event.model.providerID !== INTEGRATION_ID) return
      const credential = await resolveActiveOAuth(ctx)
      if (!credential) return

      const request = event.request
      const { input: rewrittenInput } = rewriteUrl(request.url)
      const url =
        typeof rewrittenInput === 'string'
          ? rewrittenInput
          : rewrittenInput instanceof Request
            ? rewrittenInput.url
            : rewrittenInput.toString()
      if (!isTrustedAnthropicUrl(url)) {
        throw new Error(
          'Refusing to send Anthropic OAuth credentials to an untrusted origin',
        )
      }

      const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
      const declaredLength = contentLength(request.headers)
      if (
        hasBody &&
        declaredLength !== undefined &&
        declaredLength > MAX_REQUEST_BODY_BYTES
      ) {
        throw new BodyLimitError(
          'Anthropic request body',
          MAX_REQUEST_BODY_BYTES,
        )
      }
      const bodyText = hasBody
        ? await readBoundedText(
            request.clone().body,
            MAX_REQUEST_BODY_BYTES,
            'Anthropic request body',
          )
        : undefined
      const rewrittenBody =
        bodyText !== undefined ? rewriteRequestBody(bodyText) : undefined

      const headers = mergeHeaders(request)
      setOAuthHeaders(headers, credential.access)
      if (rewrittenBody !== undefined) headers.delete('content-length')

      event.request = new Request(url, {
        method: request.method,
        headers,
        body: rewrittenBody,
        signal: request.signal,
        redirect: 'error',
      })
    })

    await ctx.session.hook('http.response', (event) => {
      if (event.model.providerID !== INTEGRATION_ID) return
      if (!isTransformedOAuthRequest(event.request)) return
      event.response = createStrippedStream(event.response)
    })
  },
})
