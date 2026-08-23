import {
  AUTHORIZE_URLS,
  CLIENT_ID,
  CODE_CALLBACK_URL,
  OAUTH_SCOPES,
  TOKEN_URL,
} from './constants.ts'
import { generatePKCE } from './pkce.ts'

type CallbackParams = {
  code: string
  state: string
}

type TokenResponse = {
  refresh_token: string
  access_token: string
  expires_in: number
}

const REFRESH_TIMEOUT_MS = 30_000

function isTokenResponse(value: unknown): value is TokenResponse {
  if (typeof value !== 'object' || value === null) return false
  if (!('refresh_token' in value) || !('access_token' in value)) return false
  if (!('expires_in' in value)) return false
  return (
    typeof value.refresh_token === 'string' &&
    value.refresh_token.length > 0 &&
    typeof value.access_token === 'string' &&
    value.access_token.length > 0 &&
    typeof value.expires_in === 'number' &&
    Number.isSafeInteger(value.expires_in) &&
    value.expires_in > 0
  )
}

async function parseTokenResponse(response: Response) {
  try {
    const value: unknown = await response.json()
    if (!isTokenResponse(value)) return undefined
    const expires = Date.now() + value.expires_in * 1000
    if (!Number.isSafeInteger(expires)) return undefined
    return {
      refresh: value.refresh_token,
      access: value.access_token,
      expires,
    }
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

export type AuthorizationResult = {
  url: string
  redirectUri: string
  state: string
  verifier: string
}

function generateState() {
  return crypto.randomUUID().replace(/-/g, '')
}

function parseCallbackInput(input: string) {
  const trimmed = input.trim()

  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code && state) {
      return { code, state }
    }
  } catch {
    // Fall through to legacy/manual formats.
  }

  const hashSplits = trimmed.split('#')
  if (hashSplits.length === 2 && hashSplits[0] && hashSplits[1]) {
    return { code: hashSplits[0], state: hashSplits[1] }
  }

  const params = new URLSearchParams(trimmed)
  const code = params.get('code')
  const state = params.get('state')
  if (code && state) {
    return { code, state }
  }

  return null
}

async function exchangeCode(
  callback: CallbackParams,
  verifier: string,
  redirectUri: string,
): Promise<ExchangeResult> {
  const result = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'axios/1.13.6',
    },
    body: JSON.stringify({
      code: callback.code,
      state: callback.state,
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  })

  if (!result.ok) {
    return {
      type: 'failed',
    }
  }

  const tokens = await parseTokenResponse(result)
  if (!tokens) return { type: 'failed' }

  return {
    type: 'success',
    ...tokens,
  }
}

export async function authorize(
  mode: 'max' | 'console',
): Promise<AuthorizationResult> {
  const pkce = await generatePKCE()
  const state = generateState()

  const url = new URL(AUTHORIZE_URLS[mode], import.meta.url)
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', CODE_CALLBACK_URL)
  url.searchParams.set('scope', OAUTH_SCOPES.join(' '))
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)

  return {
    url: url.toString(),
    redirectUri: CODE_CALLBACK_URL,
    state,
    verifier: pkce.verifier,
  }
}

export type ExchangeResult =
  | { type: 'success'; refresh: string; access: string; expires: number }
  | { type: 'failed' }

export async function exchange(
  input: string,
  verifier: string,
  redirectUri: string,
  expectedState?: string,
): Promise<ExchangeResult> {
  const callback = parseCallbackInput(input)
  if (!callback) {
    return {
      type: 'failed',
    }
  }

  if (expectedState && callback.state !== expectedState) {
    return {
      type: 'failed',
    }
  }

  return exchangeCode(callback, verifier, redirectUri)
}

export type RefreshResult =
  | { type: 'success'; refresh: string; access: string; expires: number }
  | { type: 'failed'; status: number }

/**
 * Exchange a refresh token for a new access/refresh token pair.
 * Retries transient (5xx, network) failures with exponential backoff;
 * non-transient failures (e.g. 403 on a revoked/rotated-away token)
 * are returned immediately as `{ type: 'failed' }`.
 */
export async function refreshToken(
  refreshTokenValue: string,
): Promise<RefreshResult> {
  const maxRetries = 2
  const baseDelayMs = 500

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = baseDelayMs * 2 ** (attempt - 1)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }

      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          'User-Agent': 'axios/1.13.6',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshTokenValue,
          client_id: CLIENT_ID,
        }),
      })

      if (!response.ok) {
        if (response.status >= 500 && attempt < maxRetries) {
          await response.body?.cancel()
          continue
        }

        await response.body?.cancel()
        return { type: 'failed', status: response.status }
      }

      const tokens = await parseTokenResponse(response)
      if (!tokens) {
        return { type: 'failed', status: response.status }
      }

      return {
        type: 'success',
        ...tokens,
      }
    } catch (error) {
      const isNetworkError =
        (typeof error === 'object' &&
          error !== null &&
          'name' in error &&
          (error.name === 'TimeoutError' || error.name === 'AbortError')) ||
        (error instanceof Error &&
          (error.message.includes('fetch failed') ||
            ('code' in error &&
              (error.code === 'ECONNRESET' ||
                error.code === 'ECONNREFUSED' ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'UND_ERR_CONNECT_TIMEOUT'))))

      if (attempt < maxRetries && isNetworkError) {
        continue
      }

      throw error
    }
  }

  // Unreachable — each iteration either returns or throws.
  // Kept as a TypeScript exhaustiveness guard.
  throw new Error('Token refresh exhausted all retries')
}
