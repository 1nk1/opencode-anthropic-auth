import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { authorize, exchange, refreshToken } from '../auth'
import { CLIENT_ID, CODE_CALLBACK_URL, OAUTH_SCOPES } from '../constants'

afterEach(() => {
  mock.restore()
})

describe('authorize', () => {
  test('returns the hosted callback URL for max mode', async () => {
    const result = await authorize('max')

    expect(result.url).toBeString()
    expect(result.redirectUri).toBe(CODE_CALLBACK_URL)
    expect(result.verifier).toBeString()

    const url = new URL(result.url)
    expect(url.origin).toBe('https://claude.ai')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('redirect_uri')).toBe(CODE_CALLBACK_URL)
  })

  test('returns the hosted callback URL for console mode', async () => {
    const result = await authorize('console')

    const url = new URL(result.url)
    expect(url.origin).toBe('https://platform.claude.com')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('redirect_uri')).toBe(CODE_CALLBACK_URL)
  })

  test('sets required OAuth query params', async () => {
    const result = await authorize('max')
    const url = new URL(result.url)

    expect(url.searchParams.get('code')).toBe('true')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe(CODE_CALLBACK_URL)
    expect(url.searchParams.get('scope')).toBe(OAUTH_SCOPES.join(' '))
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe(result.state)
  })

  test('does not use localhost', async () => {
    const result = await authorize('max')
    expect(result.redirectUri).not.toContain('localhost')
    expect(result.url).not.toContain('localhost')
  })
})

describe('exchange', () => {
  test('accepts code#state format', async () => {
    let capturedBody: string | undefined

    spyOn(globalThis, 'fetch').mockImplementation(((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = init?.body as string
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'r',
            access_token: 'a',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as typeof fetch)

    const result = await exchange(
      'mycode#mystate',
      'myverifier',
      CODE_CALLBACK_URL,
      'mystate',
    )

    expect(result.type).toBe('success')
    const body = JSON.parse(capturedBody!)
    expect(body.code).toBe('mycode')
    expect(body.state).toBe('mystate')
    expect(body.redirect_uri).toBe(CODE_CALLBACK_URL)
  })

  test('accepts a full callback URL', async () => {
    let capturedBody: string | undefined

    spyOn(globalThis, 'fetch').mockImplementation(((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = init?.body as string
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'r',
            access_token: 'a',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as typeof fetch)

    await exchange(
      'https://platform.claude.com/oauth/code/callback?code=mycode&state=mystate',
      'myverifier',
      CODE_CALLBACK_URL,
      'mystate',
    )

    const body = JSON.parse(capturedBody!)
    expect(body.code).toBe('mycode')
    expect(body.state).toBe('mystate')
  })

  test('returns failed on invalid callback input', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(new Response(null))) as unknown as typeof fetch)

    const result = await exchange(
      'not-a-callback',
      'verifier',
      CODE_CALLBACK_URL,
    )
    expect(result.type).toBe('failed')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('returns failed on state mismatch', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(new Response(null))) as unknown as typeof fetch)

    const result = await exchange(
      'code#wrong',
      'verifier',
      CODE_CALLBACK_URL,
      'expected',
    )
    expect(result.type).toBe('failed')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('returns failed for a malformed token response', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ access_token: 'access' }),
    )

    const result = await exchange(
      'code#state',
      'verifier',
      CODE_CALLBACK_URL,
      'state',
    )

    expect(result.type).toBe('failed')
  })

  test('returns failed when the token response is not JSON', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>upstream error</html>', { status: 200 }),
    )

    const result = await exchange(
      'code#state',
      'verifier',
      CODE_CALLBACK_URL,
      'state',
    )

    expect(result.type).toBe('failed')
  })
})

describe('refreshToken', () => {
  test('exchanges a refresh token for a new access/refresh token pair', async () => {
    let capturedBody: string | undefined

    spyOn(globalThis, 'fetch').mockImplementation(((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = init?.body as string
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'new-refresh',
            access_token: 'new-access',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as typeof fetch)

    const result = await refreshToken('old-refresh')

    expect(result.type).toBe('success')
    if (result.type !== 'success') throw new Error('unreachable')
    expect(result.access).toBe('new-access')
    expect(result.refresh).toBe('new-refresh')
    expect(result.expires).toBeGreaterThan(Date.now())

    const body = JSON.parse(capturedBody!)
    expect(body.grant_type).toBe('refresh_token')
    expect(body.refresh_token).toBe('old-refresh')
    expect(body.client_id).toBe(CLIENT_ID)
  })

  test('retries transient (5xx) failures with backoff', async () => {
    let attempts = 0
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => unknown,
    ) => {
      handler()
      return 0
    }) as unknown as typeof setTimeout)

    spyOn(globalThis, 'fetch').mockImplementation((() => {
      attempts++
      if (attempts === 1) {
        return Promise.resolve(
          new Response('Temporary failure', { status: 500 }),
        )
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'new-refresh',
            access_token: 'new-access',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch)

    const result = await refreshToken('old-refresh')

    expect(attempts).toBe(2)
    expect(result.type).toBe('success')
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
  })

  test('returns failed after exhausting transient server retries', async () => {
    let attempts = 0
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => unknown,
    ) => {
      handler()
      return 0
    }) as unknown as typeof setTimeout)
    spyOn(globalThis, 'fetch').mockImplementation((() => {
      attempts++
      return Promise.resolve(new Response('Temporary failure', { status: 503 }))
    }) as unknown as typeof fetch)

    const result = await refreshToken('old-refresh')

    expect(result).toEqual({ type: 'failed', status: 503 })
    expect(attempts).toBe(3)
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2)
  })

  test('retries a connection reset', async () => {
    let attempts = 0
    spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => unknown,
    ) => {
      handler()
      return 0
    }) as unknown as typeof setTimeout)
    spyOn(globalThis, 'fetch').mockImplementation((() => {
      attempts++
      if (attempts === 1) {
        return Promise.reject(
          Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
        )
      }
      return Promise.resolve(
        Response.json({
          refresh_token: 'new-refresh',
          access_token: 'new-access',
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch)

    const result = await refreshToken('old-refresh')

    expect(result.type).toBe('success')
    expect(attempts).toBe(2)
  })

  test('does not retry non-network exceptions', async () => {
    const failure = new Error('unexpected parser failure')
    const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(failure)

    await expect(refreshToken('old-refresh')).rejects.toBe(failure)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test('returns failed without retrying non-transient (4xx) failures', async () => {
    let attempts = 0
    spyOn(globalThis, 'fetch').mockImplementation((() => {
      attempts++
      return Promise.resolve(new Response('Forbidden', { status: 403 }))
    }) as unknown as typeof fetch)

    const result = await refreshToken('old-refresh')

    expect(attempts).toBe(1)
    expect(result).toEqual({ type: 'failed', status: 403 })
  })

  test('returns failed for a malformed successful response', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ access_token: 'new-access' }),
    )

    const result = await refreshToken('old-refresh')

    expect(result).toEqual({ type: 'failed', status: 200 })
  })

  test('returns failed when token expiry exceeds the safe timestamp range', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        refresh_token: 'new-refresh',
        access_token: 'new-access',
        expires_in: Number.MAX_VALUE,
      }),
    )

    const result = await refreshToken('old-refresh')

    expect(result).toEqual({ type: 'failed', status: 200 })
  })

  test('returns failed when a successful response is not JSON', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>upstream error</html>', { status: 200 }),
    )

    const result = await refreshToken('old-refresh')

    expect(result).toEqual({ type: 'failed', status: 200 })
  })

  test('retries a timed-out request', async () => {
    let attempts = 0
    const timeout = new AbortController()
    const timeoutSpy = spyOn(AbortSignal, 'timeout').mockReturnValue(
      timeout.signal,
    )
    spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => unknown,
    ) => {
      handler()
      return 0
    }) as unknown as typeof setTimeout)
    spyOn(globalThis, 'fetch').mockImplementation(((_input, init) => {
      attempts++
      if (attempts === 1) {
        expect(init?.signal).toBe(timeout.signal)
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          )
          timeout.abort(
            new DOMException('The operation timed out', 'TimeoutError'),
          )
        })
      }
      return Promise.resolve(
        Response.json({
          refresh_token: 'new-refresh',
          access_token: 'new-access',
          expires_in: 3600,
        }),
      )
    }) as typeof fetch)

    const result = await refreshToken('old-refresh')

    expect(result.type).toBe('success')
    expect(attempts).toBe(2)
    expect(timeoutSpy).toHaveBeenCalledWith(30_000)
  })

  test('retries when token response body streaming times out', async () => {
    let attempts = 0
    const timeout = new AbortController()
    spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => unknown,
    ) => {
      handler()
      return 0
    }) as unknown as typeof setTimeout)
    spyOn(globalThis, 'fetch').mockImplementation(((_input, init) => {
      attempts++
      if (attempts === 1) {
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              'abort',
              () => controller.error(init.signal?.reason),
              { once: true },
            )
            queueMicrotask(() =>
              timeout.abort(
                new DOMException('The operation timed out', 'TimeoutError'),
              ),
            )
          },
        })
        return Promise.resolve(new Response(body, { status: 200 }))
      }
      return Promise.resolve(
        Response.json({
          refresh_token: 'new-refresh',
          access_token: 'new-access',
          expires_in: 3600,
        }),
      )
    }) as typeof fetch)

    const result = await refreshToken('old-refresh')

    expect(result.type).toBe('success')
    expect(attempts).toBe(2)
  })
})
