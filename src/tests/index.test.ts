import { describe, expect, mock, spyOn, test } from 'bun:test'
import plugin from '../index'
import { describeConnection } from '../rate-limit'

function shortAlias(name: string): string {
  return `mcp_T${Buffer.from(new TextEncoder().encode(name)).toString('base64url')}`
}

/**
 * Minimal mock of the OpenCode v2 promise plugin `Context`, covering only
 * the `integration` and `session` surfaces this plugin uses.
 */
function createMockContext() {
  const integrationMethods: Array<Record<string, unknown>> = []
  const commandDefinitions: Array<Record<string, unknown>> = []
  const sessionHooks = new Map<string, (event: any) => Promise<void> | void>()
  const syntheticMessages: Array<Record<string, unknown>> = []
  const ctx = {
    command: {
      transform: mock(async (cb: (draft: any) => void) => {
        cb({
          add: mock((definition: Record<string, unknown>) => {
            commandDefinitions.push(definition)
          }),
        })
        return { dispose: mock(async () => {}) }
      }),
    },
    integration: {
      transform: mock(async (cb: (draft: any) => void) => {
        const draft = {
          method: {
            update: mock((input: Record<string, unknown>) => {
              integrationMethods.push(input)
            }),
          },
        }
        cb(draft)
        return { dispose: mock(async () => {}) }
      }),
      connection: {
        active: mock(
          async (_id: string): Promise<{ id: string } | undefined> => undefined,
        ),
        resolve: mock(
          async (_connection: unknown): Promise<unknown> => undefined,
        ),
      },
    },
    session: {
      synthetic: mock(async (input: Record<string, unknown>) => {
        syntheticMessages.push(input)
        return { id: 'synthetic-1' }
      }),
      hook: mock(
        async (name: string, cb: (event: any) => Promise<void> | void) => {
          sessionHooks.set(name, cb)
          return { dispose: mock(async () => {}) }
        },
      ),
    },
  }

  return {
    ctx,
    commandDefinitions,
    integrationMethods,
    sessionHooks,
    syntheticMessages,
  }
}

describe('default export', () => {
  test('is a v2 plugin definition with an id and a setup function', () => {
    expect(plugin.id).toBe('ink1.anthropic-auth')
    expect(plugin.setup).toBeFunction()
  })
})

describe('integration registration', () => {
  test('registers a Claude Pro/Max OAuth method on the anthropic integration', async () => {
    const { ctx, integrationMethods } = createMockContext()
    await plugin.setup(ctx as any)

    expect(integrationMethods).toHaveLength(1)
    const registration = integrationMethods[0]!
    expect(registration.integrationID).toBe('anthropic')
    expect(registration.method).toEqual({
      id: 'claude-max',
      type: 'oauth',
      label: 'Claude Pro/Max',
    })
    expect(registration.authorize).toBeFunction()
    expect(registration.refresh).toBeFunction()
    expect(registration.label).toBeFunction()
  })

  test('creates a privacy-safe random label for each successful OAuth connection', async () => {
    const { ctx, integrationMethods } = createMockContext()
    await plugin.setup(ctx as any)
    const registration = integrationMethods[0] as any
    const credential = {
      type: 'oauth',
      methodID: 'claude-max',
      refresh: 'fixture-refresh-value',
      access: 'fixture-access-value',
      expires: Date.now() + 60_000,
    }

    const label = registration.label(credential)

    expect(label).toMatch(/^Claude OAuth • [A-F0-9]{8}$/)
    expect(label).not.toContain(credential.refresh)
    expect(label).not.toContain(credential.access)
  })

  test('authorize() returns a code-mode authorization pointing at claude.ai', async () => {
    const { ctx, integrationMethods } = createMockContext()
    await plugin.setup(ctx as any)

    const registration = integrationMethods[0] as any
    const authorization = await registration.authorize({})

    expect(authorization.mode).toBe('code')
    expect(authorization.instructions).toBeString()
    const url = new URL(authorization.url)
    expect(url.origin).toBe('https://claude.ai')
    expect(authorization.callback).toBeFunction()
  })

  test('authorize callback exchanges a valid code for a Credential.OAuth', async () => {
    const { ctx, integrationMethods } = createMockContext()

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'refresh-1',
            access_token: 'access-1',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any
      const authorization = await registration.authorize({})

      const credential = await authorization.callback(
        `somecode#${new URL(authorization.url).searchParams.get('state')}`,
      )

      expect(credential.type).toBe('oauth')
      expect(credential.methodID).toBe('claude-max')
      expect(credential.access).toBe('access-1')
      expect(credential.refresh).toBe('refresh-1')
      expect(credential.expires).toBeGreaterThan(Date.now())
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('authorize callback throws on a failed exchange (invalid code)', async () => {
    const { ctx, integrationMethods } = createMockContext()
    await plugin.setup(ctx as any)

    const registration = integrationMethods[0] as any
    const authorization = await registration.authorize({})

    await expect(
      authorization.callback('not-a-valid-callback'),
    ).rejects.toThrow(/Failed to exchange/)
  })

  test('refresh() exchanges the refresh token for a rotated Credential.OAuth', async () => {
    const { ctx, integrationMethods } = createMockContext()

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock((_input: any, init: any) => {
      const body = JSON.parse(init.body)
      expect(body.grant_type).toBe('refresh_token')
      expect(body.refresh_token).toBe('old-refresh')
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
    }) as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any

      const rotated = await registration.refresh({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'old-refresh',
        access: 'old-access',
        expires: Date.now() - 1000,
      })

      expect(rotated).toEqual({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'new-refresh',
        access: 'new-access',
        expires: rotated.expires,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('refresh() throws a descriptive error on failure', async () => {
    const { ctx, integrationMethods } = createMockContext()

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('Forbidden', { status: 403 })),
    ) as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any

      await expect(
        registration.refresh({
          type: 'oauth',
          methodID: 'claude-max',
          refresh: 'old-refresh',
          access: 'old-access',
          expires: Date.now() - 1000,
        }),
      ).rejects.toThrow('Anthropic token refresh failed: 403')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('rejects a corrupted multibyte refresh token before fetching', async () => {
    const { ctx, integrationMethods } = createMockContext()
    const fetchSpy = mock(() =>
      Promise.resolve(
        Response.json({
          refresh_token: 'new-refresh',
          access_token: 'new-access',
          expires_in: 3600,
        }),
      ),
    )
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any
      const refresh = `corrupt-${'😀'.repeat(3000)}`
      expect(refresh.length).toBeLessThan(8192)
      expect(new TextEncoder().encode(refresh).byteLength).toBeGreaterThan(8192)

      await expect(
        registration.refresh({
          type: 'oauth',
          methodID: 'claude-max',
          refresh,
          access: 'old-access',
          expires: Date.now() - 1000,
        }),
      ).rejects.toThrow()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('bounds distinct in-flight refreshes and preserves joining callers', async () => {
    const { ctx, integrationMethods } = createMockContext()
    const originalFetch = globalThis.fetch
    const resolvers = new Map<string, (response: Response) => void>()
    let tokenRequests = 0
    globalThis.fetch = mock((_input: unknown, init?: RequestInit) => {
      tokenRequests++
      const token = String(
        (JSON.parse(String(init?.body)) as { refresh_token: string })
          .refresh_token,
      )
      return new Promise<Response>((resolve) => {
        resolvers.set(token, resolve)
      })
    }) as unknown as typeof fetch

    try {
      const cleanup = await plugin.setup(ctx as any)
      let pending: Promise<unknown>[] = []
      try {
        const registration = integrationMethods[0] as any
        const credential = (refresh: string) => ({
          type: 'oauth' as const,
          methodID: 'claude-max',
          refresh,
          access: 'old-access',
          expires: Date.now() - 1000,
        })
        const tokens = Array.from(
          { length: 256 },
          (_, index) => `capacity-${index}`,
        )
        const inFlight = tokens.map((token) =>
          registration.refresh(credential(token)),
        )
        pending = [...inFlight]

        expect(tokenRequests).toBe(256)
        expect(resolvers.size).toBe(256)
        const overflow = registration.refresh(credential('capacity-256'))
        pending.push(overflow)
        expect(tokenRequests).toBe(256)

        const joined = registration.refresh(credential(tokens[0]!))
        pending.push(joined)
        expect(tokenRequests).toBe(256)

        for (const [token, resolve] of resolvers) {
          resolve(
            Response.json({
              refresh_token: `rotated-${token}`,
              access_token: `access-${token}`,
              expires_in: 3600,
            }),
          )
        }
        await expect(overflow).rejects.toThrow(
          'Too many active Anthropic token refreshes',
        )
        await Promise.allSettled(pending)
        expect(tokenRequests).toBe(256)
      } finally {
        for (const [token, resolve] of resolvers) {
          resolve(
            Response.json({
              refresh_token: `rotated-${token}`,
              access_token: `access-${token}`,
              expires_in: 3600,
            }),
          )
        }
        await Promise.allSettled(pending)
        await cleanup?.()
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('concurrent refresh() calls deduplicate to a single token request', async () => {
    const { ctx, integrationMethods } = createMockContext()

    let tokenRequests = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() => {
      tokenRequests++
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
    }) as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any
      const credential = {
        type: 'oauth' as const,
        methodID: 'claude-max',
        refresh: 'old-refresh',
        access: 'old-access',
        expires: Date.now() - 1000,
      }

      const results = await Promise.all(
        Array.from({ length: 5 }, () => registration.refresh(credential)),
      )

      expect(tokenRequests).toBe(1)
      for (const result of results) {
        expect(result.access).toBe('new-access')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('deduplicates concurrent refreshes across independent plugin setups', async () => {
    const firstContext = createMockContext()
    const secondContext = createMockContext()
    let tokenRequests = 0
    let releaseResponse!: () => void
    let responseReleased = false
    const responseReady = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      tokenRequests++
      await responseReady
      return Response.json({
        ['refresh' + '_token']: 'new-' + 'refresh',
        ['access' + '_token']: 'new-' + 'access',
        expires_in: 3600,
      })
    }) as unknown as typeof fetch

    try {
      await Promise.all([
        plugin.setup(firstContext.ctx as any),
        plugin.setup(secondContext.ctx as any),
      ])
      const firstRegistration = firstContext.integrationMethods[0] as any
      const secondRegistration = secondContext.integrationMethods[0] as any
      const credential = {
        type: 'oauth' as const,
        methodID: 'claude-max',
        refresh: 'old-' + 'refresh',
        access: 'old-' + 'access',
        expires: Date.now() - 1000,
      }

      const firstRefresh = firstRegistration.refresh(credential)
      const secondRefresh = secondRegistration.refresh(credential)
      await Promise.resolve()
      responseReleased = true
      releaseResponse()
      const [first, second] = await Promise.all([firstRefresh, secondRefresh])

      expect(tokenRequests).toBe(1)
      expect(second).toEqual(first)
    } finally {
      if (!responseReleased) releaseResponse()
      globalThis.fetch = originalFetch
    }
  })

  test.each([
    ['HTTP 503', () => Promise.resolve(new Response('busy', { status: 503 }))],
    [
      'network failure status 0',
      () =>
        Promise.reject(
          Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
        ),
    ],
    [
      'malformed 200 body',
      () => Promise.resolve(new Response('{', { status: 200 })),
    ],
  ])('does not retry an ambiguous %s refresh across independent setups', async (_description, response) => {
    const firstContext = createMockContext()
    const secondContext = createMockContext()
    const refresh = `ambiguous-${_description.replaceAll(' ', '-')}`
    let tokenRequests = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() => {
      tokenRequests++
      return response() as Promise<Response>
    }) as unknown as typeof fetch

    try {
      await Promise.all([
        plugin.setup(firstContext.ctx as any),
        plugin.setup(secondContext.ctx as any),
      ])
      const firstRegistration = firstContext.integrationMethods[0] as any
      const secondRegistration = secondContext.integrationMethods[0] as any
      const credential = {
        type: 'oauth' as const,
        methodID: 'claude-max',
        refresh,
        access: 'old-access',
        expires: Date.now() - 1000,
      }

      await expect(firstRegistration.refresh(credential)).rejects.toThrow()
      await expect(secondRegistration.refresh(credential)).rejects.toThrow()
      expect(tokenRequests).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('a deterministic 400 refresh failure may start a later request', async () => {
    const { ctx, integrationMethods } = createMockContext()
    const refresh = `deterministic-${crypto.randomUUID()}`
    let tokenRequests = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() => {
      tokenRequests++
      return Promise.resolve(new Response('invalid', { status: 400 }))
    }) as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any
      const credential = {
        type: 'oauth' as const,
        methodID: 'claude-max',
        refresh,
        access: 'old-access',
        expires: Date.now() - 1000,
      }
      await expect(registration.refresh(credential)).rejects.toThrow()
      await expect(registration.refresh(credential)).rejects.toThrow()
      expect(tokenRequests).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('keeps different refresh tokens isolated across independent setups', async () => {
    const firstContext = createMockContext()
    const secondContext = createMockContext()
    const seen: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock((_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const refresh = String(body.refresh_token)
      seen.push(refresh)
      return Promise.resolve(
        Response.json({
          ['refresh' + '_token']: `new-${refresh}`,
          ['access' + '_token']: `access-${refresh}`,
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch

    try {
      await Promise.all([
        plugin.setup(firstContext.ctx as any),
        plugin.setup(secondContext.ctx as any),
      ])
      const first = await (firstContext.integrationMethods[0] as any).refresh({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'first-' + 'refresh',
        access: 'old-' + 'access',
        expires: Date.now() - 1000,
      })
      const second = await (secondContext.integrationMethods[0] as any).refresh(
        {
          type: 'oauth',
          methodID: 'claude-max',
          refresh: 'second-' + 'refresh',
          access: 'old-' + 'access',
          expires: Date.now() - 1000,
        },
      )

      expect(seen.toSorted()).toEqual([
        'first-' + 'refresh',
        'second-' + 'refresh',
      ])
      expect(first.access).toBe('access-first-' + 'refresh')
      expect(second.access).toBe('access-second-' + 'refresh')
      expect(first).not.toEqual(second)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('reuses a successful refresh for delayed calls with the rotated token', async () => {
    const { ctx, integrationMethods } = createMockContext()

    let tokenRequests = 0
    const originalFetch = globalThis.fetch
    let expireCachedRefresh: (() => void) | undefined
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => void,
      delay: number,
    ) => {
      if (delay === 30_000) expireCachedRefresh = handler
      return { unref() {} }
    }) as unknown as typeof setTimeout)
    globalThis.fetch = mock(() => {
      tokenRequests++
      return Promise.resolve(
        Response.json({
          refresh_token: 'new-refresh',
          access_token: 'new-access',
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any
      const credential = {
        type: 'oauth' as const,
        methodID: 'claude-max',
        refresh: 'old-refresh',
        access: 'old-access',
        expires: Date.now() - 1000,
      }

      const first = await registration.refresh(credential)
      const delayed = await registration.refresh(credential)

      expect(tokenRequests).toBe(1)
      expect(delayed).toEqual(first)

      expireCachedRefresh?.()
      await registration.refresh(credential)
      expect(tokenRequests).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
      setTimeoutSpy.mockRestore()
    }
  })

  test('fails closed instead of replaying a token when the settled refresh cache is full', async () => {
    const { ctx, integrationMethods } = createMockContext()
    const prefix = `cache-bound-${crypto.randomUUID()}`
    let tokenRequests = 0
    const originalFetch = globalThis.fetch
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      (() => ({ unref() {} })) as unknown as typeof setTimeout,
    )
    globalThis.fetch = mock((_input: unknown, init?: RequestInit) => {
      tokenRequests++
      const refresh = String(
        (JSON.parse(String(init?.body)) as { refresh_token: string })
          .refresh_token,
      )
      return Promise.resolve(
        Response.json({
          refresh_token: `rotated-${refresh}`,
          access_token: `access-${refresh}`,
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch

    try {
      const cleanup = await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any
      const credential = (index: number) => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: `${prefix}-${index}`,
        access: 'old-access',
        expires: Date.now() - 1000,
      })
      for (let index = 0; index < 256; index++) {
        await registration.refresh(credential(index))
      }
      await expect(registration.refresh(credential(256))).rejects.toThrow(
        'consumed-token cache expires',
      )
      expect(tokenRequests).toBe(256)

      await registration.refresh(credential(0))
      expect(tokenRequests).toBe(256)
      await cleanup?.()
    } finally {
      globalThis.fetch = originalFetch
      setTimeoutSpy.mockRestore()
    }
  })

  test('clears settled refresh credentials and timers during setup cleanup', async () => {
    const { ctx, integrationMethods } = createMockContext()
    const refresh = `cleanup-${crypto.randomUUID()}`
    let tokenRequests = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() => {
      tokenRequests++
      return Promise.resolve(
        Response.json({
          refresh_token: `rotated-${refresh}`,
          access_token: `access-${refresh}`,
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch

    try {
      const cleanup = await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any
      const credential = {
        type: 'oauth',
        methodID: 'claude-max',
        refresh,
        access: 'old-access',
        expires: Date.now() - 1000,
      }
      await registration.refresh(credential)
      await registration.refresh(credential)
      expect(tokenRequests).toBe(1)

      await cleanup?.()
      await registration.refresh(credential)
      expect(tokenRequests).toBe(2)
      await cleanup?.()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('concurrent refreshes keep different credentials isolated', async () => {
    const { ctx, integrationMethods } = createMockContext()
    const refreshTokens: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock((_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const refreshToken = String(body.refresh_token)
      refreshTokens.push(refreshToken)
      return Promise.resolve(
        Response.json({
          refresh_token: `new-${refreshToken}`,
          access_token: `access-${refreshToken}`,
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any
      const credential = (refresh: string) => ({
        type: 'oauth' as const,
        methodID: 'claude-max',
        refresh,
        access: 'old-access',
        expires: Date.now() - 1000,
      })

      const [first, second] = await Promise.all([
        registration.refresh(credential('first')),
        registration.refresh(credential('second')),
      ])

      expect(refreshTokens.toSorted()).toEqual(['first', 'second'])
      expect(first.access).toBe('access-first')
      expect(second.access).toBe('access-second')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('anthropic-auth-status command', () => {
  test('reports the active connection without resolving credentials or exposing a custom label', async () => {
    const { ctx, commandDefinitions, syntheticMessages } = createMockContext()
    const connection = {
      type: 'credential',
      id: 'cred-status-private',
      label: 'private.person@example.com',
    }
    ;(ctx.integration.connection.active as any).mockImplementation(
      async () => connection,
    )
    await plugin.setup(ctx as any)

    expect(commandDefinitions).toHaveLength(1)
    const definition = commandDefinitions[0] as any
    expect(definition.name).toBe('anthropic-auth-status')
    await definition.execute({ sessionID: 'ses-status' })

    expect(ctx.integration.connection.active).toHaveBeenCalledWith('anthropic')
    expect(ctx.integration.connection.resolve).not.toHaveBeenCalled()
    expect(syntheticMessages).toEqual([
      {
        sessionID: 'ses-status',
        text: `Anthropic auth status: active ${describeConnection(connection)}. Credential values were not resolved.`,
        description: 'Anthropic authentication status',
        resume: false,
      },
    ])
    expect(String(syntheticMessages[0]?.text)).not.toContain(
      'private.person@example.com',
    )
  })
})

describe('session http.request hook', () => {
  function anthropicOAuthContext() {
    const mocked = createMockContext()
    ;(mocked.ctx.integration.connection.active as any).mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    ;(mocked.ctx.integration.connection.resolve as any).mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'my-access-token',
        expires: Date.now() + 100000,
      }),
    )
    return mocked
  }

  test('ignores non-anthropic providers', async () => {
    const { ctx, sessionHooks } = createMockContext()
    await plugin.setup(ctx as any)

    const originalRequest = new Request('https://api.openai.com/v1/chat', {
      method: 'POST',
      body: '{}',
    })
    const event: any = {
      model: { providerID: 'openai', modelID: 'gpt' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')!(event)

    expect(event.request).toBe(originalRequest)
  })

  test('leaves API-key Anthropic requests untouched', async () => {
    const { ctx, sessionHooks } = createMockContext()
    await plugin.setup(ctx as any)

    const originalRequest = new Request(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        body: '{}',
      },
    )
    const event: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')!(event)

    expect(event.request).toBe(originalRequest)
  })

  test('rewrites headers, body, and URL for an active OAuth connection', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)

    const body = JSON.stringify({
      tools: [{ name: 'bash', type: 'function' }],
      messages: [{ role: 'user', content: 'hello world test message' }],
      system: 'You are a helpful assistant.',
    })
    const originalRequest = new Request(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'content-length': String(body.length),
          'content-encoding': 'gzip',
          'content-digest': 'sha-256=:stale:',
          'content-md5': 'stale',
          'content-range': 'bytes 0-1/2',
          digest: 'sha-256=stale',
          etag: 'stale',
          'x-api-key': 'my-access-token',
        },
        body,
      },
    )
    const event: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')!(event)

    expect(event.request).not.toBe(originalRequest)
    const rewritten: Request = event.request
    expect(rewritten.headers.get('authorization')).toBe(
      'Bearer my-access-token',
    )
    expect(rewritten.headers.get('x-api-key')).toBeNull()
    expect(rewritten.headers.get('content-length')).toBeNull()
    expect(rewritten.headers.get('content-encoding')).toBeNull()
    expect(rewritten.headers.get('content-digest')).toBeNull()
    expect(rewritten.headers.get('content-md5')).toBeNull()
    expect(rewritten.headers.get('content-range')).toBeNull()
    expect(rewritten.headers.get('digest')).toBeNull()
    expect(rewritten.headers.get('etag')).toBeNull()
    expect(rewritten.redirect).toBe('error')
    expect(rewritten.headers.get('anthropic-beta')).toContain(
      'oauth-2025-04-20',
    )
    expect(rewritten.url).toContain('beta=true')

    const parsedBody = JSON.parse(await rewritten.text())
    expect(parsedBody.tools[0].name).toBe(shortAlias('bash'))
    expect(parsedBody.system[1].text).toBe(
      "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    )
  })

  test('preserves GET requests without a body', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)

    const originalRequest = new Request('https://api.anthropic.com/v1/models', {
      method: 'GET',
    })
    const event: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')!(event)

    const rewritten: Request = event.request
    expect(rewritten.method).toBe('GET')
    expect(await rewritten.text()).toBe('')
  })

  test('preserves POST requests without a body', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)

    const originalRequest = new Request(
      'https://api.anthropic.com/v1/messages',
      { method: 'POST' },
    )
    const event: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')!(event)

    const rewritten: Request = event.request
    expect(rewritten.method).toBe('POST')
    expect(rewritten.body).toBeNull()
  })

  test('does not rewrite an unrelated Anthropic POST endpoint body or representation headers', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)
    const body = '{"model":"claude-3"}'
    const originalRequest = new Request('https://api.anthropic.com/v1/models', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length),
        'content-encoding': 'gzip',
        etag: '"model-list"',
        'x-api-key': 'stale-key',
      },
      body,
    })
    const event: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }

    await sessionHooks.get('http.request')!(event)

    const rewritten: Request = event.request
    expect(await rewritten.text()).toBe(body)
    expect(rewritten.headers.get('content-type')).toBe('application/json')
    expect(rewritten.headers.get('content-length')).toBe(
      originalRequest.headers.get('content-length'),
    )
    expect(rewritten.headers.get('content-encoding')).toBe('gzip')
    expect(rewritten.headers.get('etag')).toBe('"model-list"')
    expect(rewritten.headers.get('authorization')).toBe(
      'Bearer my-access-token',
    )
  })

  test('keeps invalid body and representation headers coherent on unrelated endpoints', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)
    const body = 'not-json'
    const originalRequest = new Request('https://api.anthropic.com/v1/models', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length),
        digest: 'sha-256=upstream',
      },
      body,
    })
    const event: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }

    await sessionHooks.get('http.request')!(event)

    const rewritten: Request = event.request
    expect(await rewritten.text()).toBe(body)
    expect(rewritten.headers.get('content-type')).toBe('application/json')
    expect(rewritten.headers.get('content-length')).toBe(
      originalRequest.headers.get('content-length'),
    )
    expect(rewritten.headers.get('digest')).toBe('sha-256=upstream')
    expect(rewritten.headers.get('authorization')).toBe(
      'Bearer my-access-token',
    )
  })

  test('rewrites count_tokens request bodies but does not transform their responses', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)
    const requestEvent: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request(
        'https://api.anthropic.com/v1/messages/count_tokens',
        {
          method: 'POST',
          body: JSON.stringify({
            tools: [{ name: 'bash', type: 'function' }],
            system: 'Count this',
            messages: [{ role: 'user', content: 'hello' }],
          }),
        },
      ),
    }
    await sessionHooks.get('http.request')!(requestEvent)

    const parsedBody = JSON.parse(await requestEvent.request.text())
    expect(parsedBody.tools[0].name).toBe(shortAlias('bash'))
    expect(parsedBody.system[1].text).toBe(
      "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    )

    const responseBody = '{"input_tokens":42}'
    const originalResponse = new Response(responseBody, {
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'count-tokens-1',
        'x-ratelimit-remaining': '99',
      },
    })
    const responseEvent: any = {
      model: requestEvent.model,
      request: requestEvent.request,
      response: originalResponse,
    }
    await sessionHooks.get('http.response')!(responseEvent)

    expect(responseEvent.response).toBe(originalResponse)
    expect(responseEvent.response.status).toBe(200)
    expect(responseEvent.response.statusText).toBe('OK')
    expect(responseEvent.response.headers.get('content-type')).toBe(
      'application/json',
    )
    expect(responseEvent.response.headers.get('x-request-id')).toBe(
      'count-tokens-1',
    )
    expect(responseEvent.response.headers.get('x-ratelimit-remaining')).toBe(
      '99',
    )
    expect(await responseEvent.response.text()).toBe(responseBody)
  })

  test('refuses to send OAuth credentials to an untrusted origin', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)

    const originalRequest = new Request(
      'https://api.anthropic.com.evil.test/v1/messages',
      { method: 'POST', body: '{}' },
    )
    const event: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }

    await expect(sessionHooks.get('http.request')!(event)).rejects.toThrow(
      'Refusing to send Anthropic OAuth credentials to an untrusted origin',
    )
    expect(event.request).toBe(originalRequest)
    expect(event.request.headers.get('authorization')).toBeNull()
  })

  test('rejects a declared request body above 10 MiB', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)

    const originalRequest = new Request(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: { 'content-length': String(10 * 1024 * 1024 + 1) },
        body: '{}',
      },
    )
    const event: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }

    await expect(sessionHooks.get('http.request')!(event)).rejects.toThrow(
      'Anthropic request body exceeds 10485760 byte limit',
    )
    expect(event.request).toBe(originalRequest)
  })
})

describe('session http.response hook', () => {
  function anthropicOAuthContext() {
    const mocked = createMockContext()
    ;(mocked.ctx.integration.connection.active as any).mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    ;(mocked.ctx.integration.connection.resolve as any).mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'my-access-token',
        expires: Date.now() + 100000,
      }),
    )
    return mocked
  }

  test('shares identical long aliases across concurrent reconstructed responses and cleans up after both', async () => {
    const { ctx, sessionHooks } = createMockContext()
    ;(ctx.integration.connection.active as any).mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    ;(ctx.integration.connection.resolve as any).mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'a',
        expires: Date.now() + 100000,
      }),
    )
    await plugin.setup(ctx as any)

    const sourceName = 'x'.repeat(64)
    const body = JSON.stringify({ tools: [{ name: sourceName }] })
    const model = { providerID: 'anthropic', modelID: 'claude-3' }
    const requestEventA: any = {
      model,
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body,
      }),
    }
    const requestEventB: any = {
      model,
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body,
      }),
    }

    const requestHook = sessionHooks.get('http.request')!
    await Promise.all([requestHook(requestEventA), requestHook(requestEventB)])
    const aliasA = JSON.parse(await requestEventA.request.clone().text())
      .tools[0].name
    const aliasB = JSON.parse(await requestEventB.request.clone().text())
      .tools[0].name
    expect(aliasA).toBe(aliasB)
    expect(aliasA).not.toBe(sourceName)

    const responseHook = sessionHooks.get('http.response')!
    const responseEventA: any = {
      model,
      request: new Request(requestEventA.request),
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: aliasA }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }
    const responseEventB: any = {
      model,
      request: new Request(requestEventB.request),
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: aliasB }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }

    await Promise.all([
      responseHook(responseEventA),
      responseHook(responseEventB),
    ])
    const [decodedA, decodedB] = await Promise.all([
      responseEventA.response.text(),
      responseEventB.response.text(),
    ])
    expect(JSON.parse(decodedA).content[0].name).toBe(sourceName)
    expect(JSON.parse(decodedB).content[0].name).toBe(sourceName)

    const thirdEvent: any = {
      model,
      request: new Request(requestEventA.request),
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: aliasA }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }
    await responseHook(thirdEvent)
    expect(JSON.parse(await thirdEvent.response.text()).content[0].name).toBe(
      aliasA,
    )
  })

  test('keeps one long alias alive across multiple concurrent reconstructed response streams', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)
    const originalName = 'parallel-reconstructed-'.repeat(4)
    const model = { providerID: 'anthropic', modelID: 'claude-3' }
    const requestEvent: any = {
      model,
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    await sessionHooks.get('http.request')!(requestEvent)
    const alias = JSON.parse(await requestEvent.request.clone().text()).tools[0]
      .name
    const encoder = new TextEncoder()
    let firstController!: ReadableStreamDefaultController<Uint8Array>
    let secondController!: ReadableStreamDefaultController<Uint8Array>
    const responseBody = JSON.stringify({
      type: 'message',
      content: [{ type: 'tool_use', name: alias }],
    })
    const responseEvent = (
      controllerReady: (
        controller: ReadableStreamDefaultController<Uint8Array>,
      ) => void,
    ): any => ({
      model,
      request: new Request(requestEvent.request),
      response: new Response(
        new ReadableStream<Uint8Array>({ start: controllerReady }),
        { headers: { 'content-type': 'application/json' } },
      ),
    })
    const firstEvent = responseEvent((controller) => {
      firstController = controller
    })
    const secondEvent = responseEvent((controller) => {
      secondController = controller
    })
    const responseHook = sessionHooks.get('http.response')!
    await responseHook(firstEvent)
    await responseHook(secondEvent)

    firstController.enqueue(encoder.encode(responseBody))
    firstController.close()
    expect(JSON.parse(await firstEvent.response.text()).content[0].name).toBe(
      originalName,
    )

    secondController.enqueue(encoder.encode(responseBody))
    secondController.close()
    expect(JSON.parse(await secondEvent.response.text()).content[0].name).toBe(
      originalName,
    )
  })

  test('keeps reconstructed ownership atomic when a concurrent response finalizes synchronously', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)
    const originalName = 'synchronous-passthrough-'.repeat(4)
    const model = { providerID: 'anthropic', modelID: 'claude-3' }
    const requestEvent: any = {
      model,
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    await sessionHooks.get('http.request')!(requestEvent)
    const alias = JSON.parse(await requestEvent.request.clone().text()).tools[0]
      .name
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const passthroughEvent: any = {
      model,
      request: new Request(requestEvent.request),
      response: new Response('unchanged', {
        headers: { 'content-type': 'text/plain' },
      }),
    }
    const transformedEvent: any = {
      model,
      request: new Request(requestEvent.request),
      response: new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }
    const responseHook = sessionHooks.get('http.response')!
    await Promise.all([
      responseHook(passthroughEvent),
      responseHook(transformedEvent),
    ])
    expect(await passthroughEvent.response.text()).toBe('unchanged')

    controller.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: alias }],
        }),
      ),
    )
    controller.close()
    expect(
      JSON.parse(await transformedEvent.response.text()).content[0].name,
    ).toBe(originalName)
  })

  test('keeps aliases active past the request TTL while a response stream owns them', async () => {
    const scheduled: Array<{ handler: () => void; delay: number }> = []
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => void,
      delay: number,
    ) => {
      scheduled.push({ handler, delay })
      return { unref() {} }
    }) as unknown as typeof setTimeout)

    try {
      const { ctx, sessionHooks } = anthropicOAuthContext()
      const cleanup = await plugin.setup(ctx as any)
      const originalName = 'long-running-stream-'.repeat(4)
      const requestEvent: any = {
        model: { providerID: 'anthropic', modelID: 'claude-3' },
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: JSON.stringify({ tools: [{ name: originalName }] }),
        }),
      }
      await sessionHooks.get('http.request')!(requestEvent)
      const alias = JSON.parse(await requestEvent.request.clone().text())
        .tools[0].name
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const event: any = {
        model: requestEvent.model,
        request: requestEvent.request,
        response: new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              controller = streamController
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      }
      await sessionHooks.get('http.response')!(event)

      for (const entry of scheduled.filter(
        ({ delay }) => delay === 5 * 60_000,
      )) {
        entry.handler()
      }
      controller.enqueue(
        new TextEncoder().encode(
          `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${alias}"}}\n\n`,
        ),
      )
      controller.close()

      expect(await event.response.text()).toContain(`"name":"${originalName}"`)
      await cleanup?.()
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  test('extends an idle alias lease when an identical request reuses it', async () => {
    const scheduled: Array<{ handler: () => void; delay: number }> = []
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => void,
      delay: number,
    ) => {
      scheduled.push({ handler, delay })
      return { unref() {} }
    }) as unknown as typeof setTimeout)

    try {
      const { ctx, sessionHooks } = anthropicOAuthContext()
      const cleanup = await plugin.setup(ctx as any)
      const originalName = 'reused-request-'.repeat(5)
      const body = JSON.stringify({ tools: [{ name: originalName }] })
      const model = { providerID: 'anthropic', modelID: 'claude-3' }
      const requestHook = sessionHooks.get('http.request')!
      const firstEvent: any = {
        model,
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body,
        }),
      }
      await requestHook(firstEvent)
      const firstExpiry = scheduled.find(
        ({ delay }) => delay === 5 * 60_000,
      )?.handler
      expect(firstExpiry).toBeFunction()

      const secondEvent: any = {
        model,
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body,
        }),
      }
      await requestHook(secondEvent)
      const alias = JSON.parse(await secondEvent.request.clone().text())
        .tools[0].name
      firstExpiry?.()

      const responseEvent: any = {
        model,
        request: secondEvent.request,
        response: Response.json({
          type: 'message',
          content: [{ type: 'tool_use', name: alias }],
        }),
      }
      await sessionHooks.get('http.response')!(responseEvent)
      expect(
        JSON.parse(await responseEvent.response.text()).content[0].name,
      ).toBe(originalName)
      await cleanup?.()
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  test('fails closed when a reconstructed transformed request body was consumed', async () => {
    const { ctx, sessionHooks } = createMockContext()
    ;(ctx.integration.connection.active as any).mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    ;(ctx.integration.connection.resolve as any).mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'a',
        expires: Date.now() + 100000,
      }),
    )
    await plugin.setup(ctx as any)

    const sourceName = 'x'.repeat(64)
    const requestEvent: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: sourceName }] }),
      }),
    }
    await sessionHooks.get('http.request')!(requestEvent)
    const alias = JSON.parse(await requestEvent.request.clone().text()).tools[0]
      .name
    const reconstructedRequest = new Request(requestEvent.request)
    await reconstructedRequest.text()
    const responseEvent: any = {
      model: requestEvent.model,
      request: reconstructedRequest,
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: alias }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }

    await sessionHooks.get('http.response')!(responseEvent)
    expect(
      JSON.parse(await responseEvent.response.text()).content[0].name,
    ).toBe(alias)
  })

  test('delivers a successful response when reconstructed alias lookup exceeds the request bound', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)
    const originalName = 'bounded-lookup-'.repeat(8)
    const requestEvent: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    await sessionHooks.get('http.request')!(requestEvent)
    const alias = JSON.parse(await requestEvent.request.clone().text()).tools[0]
      .name
    const reconstructed = new Request(requestEvent.request)
    reconstructed.headers.set('content-length', String(10 * 1024 * 1024 + 1))
    const responseBody = JSON.stringify({
      type: 'message',
      content: [{ type: 'tool_use', name: alias }],
    })
    const event: any = {
      model: requestEvent.model,
      request: reconstructed,
      response: new Response(responseBody, {
        status: 200,
        statusText: 'OK',
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req_fixture_lookup',
        },
      }),
    }

    await expect(
      sessionHooks.get('http.response')!(event),
    ).resolves.toBeUndefined()
    expect(event.response.status).toBe(200)
    expect(event.response.statusText).toBe('OK')
    expect(event.response.headers.get('x-request-id')).toBe(
      'req_fixture_lookup',
    )
    expect(await event.response.text()).toBe(responseBody)
  })

  test('reclaims an unresolved alias lease after its idle TTL', async () => {
    const scheduled: Array<{ handler: () => void; delay: number }> = []
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => void,
      delay: number,
    ) => {
      scheduled.push({ handler, delay })
      return { unref() {} }
    }) as unknown as typeof setTimeout)

    try {
      const { ctx, sessionHooks } = anthropicOAuthContext()
      const cleanup = await plugin.setup(ctx as any)
      const originalName = 'unresolved-lease-'.repeat(5)
      const requestEvent: any = {
        model: { providerID: 'anthropic', modelID: 'claude-3' },
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: JSON.stringify({ tools: [{ name: originalName }] }),
        }),
      }
      await sessionHooks.get('http.request')!(requestEvent)
      const expiry = scheduled.find(
        ({ delay }) => delay === 5 * 60_000,
      )?.handler
      expect(expiry).toBeFunction()
      const alias = JSON.parse(await requestEvent.request.clone().text())
        .tools[0].name
      const reconstructed = new Request(requestEvent.request)
      reconstructed.headers.set('content-length', String(10 * 1024 * 1024 + 1))
      const responseHook = sessionHooks.get('http.response')!
      const unresolvedEvent: any = {
        model: requestEvent.model,
        request: reconstructed,
        response: Response.json({
          type: 'message',
          content: [{ type: 'tool_use', name: alias }],
        }),
      }
      await responseHook(unresolvedEvent)
      expect(
        JSON.parse(await unresolvedEvent.response.text()).content[0].name,
      ).toBe(alias)

      expiry?.()
      const afterExpiry: any = {
        model: requestEvent.model,
        request: requestEvent.request,
        response: Response.json({
          type: 'message',
          content: [{ type: 'tool_use', name: alias }],
        }),
      }
      await responseHook(afterExpiry)
      expect(
        JSON.parse(await afterExpiry.response.text()).content[0].name,
      ).toBe(alias)
      await cleanup?.()
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  test('releases a long alias when a transformed response body is locked', async () => {
    const { ctx, sessionHooks } = createMockContext()
    ;(ctx.integration.connection.active as any).mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    ;(ctx.integration.connection.resolve as any).mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'a',
        expires: Date.now() + 100000,
      }),
    )
    await plugin.setup(ctx as any)

    const originalName = 'x'.repeat(64)
    const requestEvent: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    await sessionHooks.get('http.request')!(requestEvent)
    const alias = JSON.parse(await requestEvent.request.clone().text()).tools[0]
      .name
    const reconstructedRequest = new Request(requestEvent.request)
    const lockedResponse = new Response(
      JSON.stringify({
        type: 'message',
        content: [{ type: 'tool_use', name: alias }],
      }),
      { headers: { 'content-type': 'application/json' } },
    )
    const reader = lockedResponse.body!.getReader()

    try {
      const lockedEvent: any = {
        model: requestEvent.model,
        request: reconstructedRequest,
        response: lockedResponse,
      }
      await expect(
        Promise.resolve().then(() =>
          sessionHooks.get('http.response')!(lockedEvent),
        ),
      ).rejects.toThrow()
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }

    const freshEvent: any = {
      model: requestEvent.model,
      request: reconstructedRequest,
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: alias }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }
    await sessionHooks.get('http.response')!(freshEvent)
    expect(JSON.parse(await freshEvent.response.text()).content[0].name).toBe(
      alias,
    )
  })

  test('preserves long aliases after setup cleanup', async () => {
    const { ctx, sessionHooks } = createMockContext()
    ;(ctx.integration.connection.active as any).mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    ;(ctx.integration.connection.resolve as any).mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'a',
        expires: Date.now() + 100000,
      }),
    )
    const cleanup = await plugin.setup(ctx as any)

    const sourceName = 'x'.repeat(64)
    const requestEvent: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: sourceName }] }),
      }),
    }
    await sessionHooks.get('http.request')!(requestEvent)
    const alias = JSON.parse(await requestEvent.request.clone().text()).tools[0]
      .name
    const reconstructedRequest = new Request(requestEvent.request)
    await cleanup?.()

    const responseEvent: any = {
      model: requestEvent.model,
      request: reconstructedRequest,
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: alias }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }
    await sessionHooks.get('http.response')!(responseEvent)
    expect(
      JSON.parse(await responseEvent.response.text()).content[0].name,
    ).toBe(alias)
  })

  test('isolates long aliases between reconstructed requests', async () => {
    const { ctx, sessionHooks } = createMockContext()
    ;(ctx.integration.connection.active as any).mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    ;(ctx.integration.connection.resolve as any).mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'a',
        expires: Date.now() + 100000,
      }),
    )
    await plugin.setup(ctx as any)

    const sourceA = 'a'.repeat(64)
    const sourceB = 'b'.repeat(64)
    const requestEventA: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: sourceA }] }),
      }),
    }
    const requestEventB: any = {
      model: requestEventA.model,
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: sourceB }] }),
      }),
    }
    await sessionHooks.get('http.request')!(requestEventA)
    await sessionHooks.get('http.request')!(requestEventB)
    const aliasA = JSON.parse(await requestEventA.request.clone().text())
      .tools[0].name
    const aliasB = JSON.parse(await requestEventB.request.clone().text())
      .tools[0].name
    expect(aliasA).not.toBe(aliasB)

    const reconstructedB = new Request(requestEventB.request)
    const responseEvent: any = {
      model: requestEventB.model,
      request: reconstructedB,
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [
            { type: 'tool_use', name: aliasA },
            { type: 'tool_use', name: aliasB },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }
    await sessionHooks.get('http.response')!(responseEvent)
    expect(JSON.parse(await responseEvent.response.text()).content).toEqual([
      { type: 'tool_use', name: aliasA },
      { type: 'tool_use', name: sourceB },
    ])
  })

  test('decodes a long tool alias after a reconstructed OAuth request', async () => {
    const mocked = createMockContext()
    const { ctx, sessionHooks } = mocked
    ;(ctx.integration.connection.active as any).mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    ;(ctx.integration.connection.resolve as any).mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'my-access-token',
        expires: Date.now() + 100000,
      }),
    )
    await plugin.setup(ctx as any)

    const originalName = 'x'.repeat(64)
    const requestEvent: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    await sessionHooks.get('http.request')!(requestEvent)
    const emittedBody = JSON.parse(await requestEvent.request.clone().text())
    const emittedAlias = emittedBody.tools[0].name
    expect(emittedAlias).not.toBe(originalName)
    expect(emittedAlias).toMatch(/^mcp_H[A-Za-z0-9_-]+$/)

    const reconstructedRequest = new Request(requestEvent.request)
    const responseEvent: any = {
      model: requestEvent.model,
      request: reconstructedRequest,
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: emittedAlias }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }
    await sessionHooks.get('http.response')!(responseEvent)

    const decoded = JSON.parse(await responseEvent.response.text())
    expect(decoded.content[0].name).toBe(originalName)
  })

  test('releases a long alias after a reconstructed response is fully consumed', async () => {
    const mocked = createMockContext()
    const { ctx, sessionHooks } = mocked
    ;(ctx.integration.connection.active as any).mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    ;(ctx.integration.connection.resolve as any).mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'my-access-token',
        expires: Date.now() + 100000,
      }),
    )
    await plugin.setup(ctx as any)

    const originalName = 'x'.repeat(64)
    const requestEvent: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    await sessionHooks.get('http.request')!(requestEvent)
    const emittedAlias = JSON.parse(await requestEvent.request.clone().text())
      .tools[0].name
    const reconstructedRequest = new Request(requestEvent.request)

    const firstEvent: any = {
      model: requestEvent.model,
      request: reconstructedRequest,
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: emittedAlias }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }
    await sessionHooks.get('http.response')!(firstEvent)
    const decoded = JSON.parse(await firstEvent.response.text())
    expect(decoded.content[0].name).toBe(originalName)

    const secondEvent: any = {
      model: requestEvent.model,
      request: reconstructedRequest,
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: emittedAlias }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }
    await sessionHooks.get('http.response')!(secondEvent)
    const preserved = JSON.parse(await secondEvent.response.text())

    expect(preserved.content[0].name).toBe(emittedAlias)
  })

  test('strips tool prefixes when the matching request used OAuth', async () => {
    const { ctx, sessionHooks } = createMockContext()
    let oauthActive = true
    ;(ctx.integration.connection.active as any).mockImplementation(async () =>
      oauthActive ? { id: 'conn-1' } : undefined,
    )
    ;(ctx.integration.connection.resolve as any).mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'a',
        expires: Date.now() + 100000,
      }),
    )
    await plugin.setup(ctx as any)

    const requestEvent: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: 'bash' }] }),
      }),
    }
    await sessionHooks.get('http.request')!(requestEvent)
    const emittedAlias = JSON.parse(await requestEvent.request.clone().text())
      .tools[0].name
    oauthActive = false

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${emittedAlias}"}}\n\n`,
          ),
        )
        controller.close()
      },
    })
    const originalResponse = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const event: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: requestEvent.request,
      response: originalResponse,
    }
    await sessionHooks.get('http.response')!(event)

    expect(event.response).not.toBe(originalResponse)
    const text = await event.response.text()
    expect(text).toContain('"name":"bash"')
    expect(text).not.toContain(emittedAlias)
  })

  test('strips tool prefixes after another hook clones the OAuth request', async () => {
    const { ctx, sessionHooks } = createMockContext()
    ;(ctx.integration.connection.active as any).mockImplementation(
      async () => ({
        id: 'conn-1',
      }),
    )
    ;(ctx.integration.connection.resolve as any).mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'a',
        expires: Date.now() + 100000,
      }),
    )
    await plugin.setup(ctx as any)

    const requestEvent: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: 'bash' }] }),
      }),
    }
    await sessionHooks.get('http.request')!(requestEvent)
    const emittedAlias = JSON.parse(await requestEvent.request.clone().text())
      .tools[0].name

    const clonedRequest = new Request(requestEvent.request)
    const responseEvent: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: clonedRequest,
      response: new Response(
        `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${emittedAlias}"}}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    }
    await sessionHooks.get('http.response')!(responseEvent)

    expect(await responseEvent.response.text()).toContain('"name":"bash"')
  })

  test('leaves non-anthropic responses untouched', async () => {
    const { ctx, sessionHooks } = createMockContext()
    await plugin.setup(ctx as any)

    const originalResponse = new Response(null, { status: 200 })
    const event: any = {
      model: { providerID: 'openai', modelID: 'gpt' },
      request: new Request('https://api.openai.com/v1/chat'),
      response: originalResponse,
    }
    await sessionHooks.get('http.response')!(event)

    expect(event.response).toBe(originalResponse)
  })

  test('leaves Anthropic responses untouched when the request did not use OAuth', async () => {
    const { ctx, sessionHooks } = createMockContext()
    await plugin.setup(ctx as any)

    const originalResponse = new Response('ok')
    const event: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages'),
      response: originalResponse,
    }
    await sessionHooks.get('http.response')!(event)

    expect(event.response).toBe(originalResponse)
  })

  test('leaves a non-2xx reconstructed response unchanged despite a forged large length', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)
    const originalName = 'x'.repeat(64)
    const requestEvent: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    await sessionHooks.get('http.request')!(requestEvent)
    const emittedAlias = JSON.parse(await requestEvent.request.clone().text())
      .tools[0].name
    const reconstructed = new Request(requestEvent.request)
    reconstructed.headers.set('content-length', String(10 * 1024 * 1024 + 1))
    const body = 'upstream failure'
    const originalResponse = new Response(body, {
      status: 503,
      statusText: 'Service Unavailable',
      headers: {
        'content-type': 'application/json',
        'content-length': String(10 * 1024 * 1024 + 1),
        etag: '"upstream"',
      },
    })
    const event: any = {
      model: requestEvent.model,
      request: reconstructed,
      response: originalResponse,
    }

    await expect(
      sessionHooks.get('http.response')!(event),
    ).resolves.toBeUndefined()
    expect(event.response).toBe(originalResponse)
    expect(event.response.status).toBe(503)
    expect(event.response.statusText).toBe('Service Unavailable')
    expect(event.response.headers.get('content-length')).toBe(
      String(10 * 1024 * 1024 + 1),
    )
    expect(await event.response.text()).toBe(body)

    // A real direct request lease is also released when the upstream response
    // is non-2xx; a later response for that request must not decode its alias.
    const directResponse = new Response(body, {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })
    const directEvent: any = {
      model: requestEvent.model,
      request: requestEvent.request,
      response: directResponse,
    }
    await sessionHooks.get('http.response')!(directEvent)
    expect(directEvent.response).toBe(directResponse)
    const laterEvent: any = {
      model: requestEvent.model,
      request: requestEvent.request,
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: emittedAlias }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }
    await sessionHooks.get('http.response')!(laterEvent)
    const laterBody = await laterEvent.response.text()
    expect(laterBody).toContain(emittedAlias)
    expect(laterBody).not.toContain(originalName)
  })

  test('releases an alias lease after a reconstructed non-2xx response', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)
    const originalName = 'r'.repeat(64)
    const requestEvent: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    await sessionHooks.get('http.request')!(requestEvent)
    const alias = JSON.parse(await requestEvent.request.clone().text()).tools[0]
      .name
    const reconstructed = new Request(requestEvent.request)
    const failedEvent: any = {
      model: requestEvent.model,
      request: reconstructed,
      response: new Response('failed', { status: 503 }),
    }
    await sessionHooks.get('http.response')!(failedEvent)

    const laterEvent: any = {
      model: requestEvent.model,
      request: requestEvent.request,
      response: Response.json({
        type: 'message',
        content: [{ type: 'tool_use', name: alias }],
      }),
    }
    await sessionHooks.get('http.response')!(laterEvent)

    expect(JSON.parse(await laterEvent.response.text()).content[0].name).toBe(
      alias,
    )
  })

  test('does not rewrite responses for an evil origin or GET request with markers', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)
    const markerHeaders = {
      authorization: 'Bearer forged',
      'anthropic-beta': 'oauth-2025-04-20, interleaved-thinking-2025-05-14',
    }
    const responseBody = JSON.stringify({
      type: 'message',
      content: [{ type: 'tool_use', name: shortAlias('forged') }],
    })
    for (const [label, request] of [
      [
        'evil origin',
        new Request('https://evil.example/v1/messages?beta=true', {
          method: 'POST',
          headers: markerHeaders,
          body: '{}',
        }),
      ],
      [
        'GET',
        new Request('https://api.anthropic.com/v1/messages?beta=true', {
          method: 'GET',
          headers: markerHeaders,
        }),
      ],
    ] as const) {
      const originalResponse = new Response(responseBody, {
        status: 200,
        headers: { 'content-type': 'application/json', etag: `"${label}"` },
      })
      const event: any = {
        model: { providerID: 'anthropic', modelID: 'claude-3' },
        request,
        response: originalResponse,
      }
      await sessionHooks.get('http.response')!(event)
      expect(event.response).toBe(originalResponse)
      expect(await event.response.text()).toBe(responseBody)
    }
  })
})

describe('multiple Anthropic connections and HTTP 429', () => {
  test('attributes each 429 to the connection used by that request and never rotates accounts', async () => {
    const { ctx, sessionHooks } = createMockContext()
    const connectionA = {
      type: 'credential',
      id: 'cred-active-a',
      label: 'Anthropic 3',
    }
    const connectionB = {
      type: 'credential',
      id: 'cred-active-b',
      label: 'Claude OAuth • 0123ABCD',
    }
    let activeConnection = connectionA
    ;(ctx.integration.connection.active as any).mockImplementation(
      async () => activeConnection,
    )
    ;(ctx.integration.connection.resolve as any).mockImplementation(
      async (connection: { id: string }) => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: `fixture-refresh-${connection.id}`,
        access:
          connection.id === connectionA.id
            ? 'fixture-access-a'
            : 'fixture-access-b',
        expires: Date.now() + 60_000,
      }),
    )
    await plugin.setup(ctx as any)

    const model = { providerID: 'anthropic', modelID: 'claude-test' }
    const requestA: any = {
      model,
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ messages: [] }),
      }),
    }
    await sessionHooks.get('http.request')!(requestA)
    expect(requestA.request.headers.get('authorization')).toBe(
      'Bearer fixture-access-a',
    )

    activeConnection = connectionB
    const requestB: any = {
      model,
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content: 'b' }] }),
      }),
    }
    await sessionHooks.get('http.request')!(requestB)
    expect(requestB.request.headers.get('authorization')).toBe(
      'Bearer fixture-access-b',
    )

    const responseA: any = {
      model,
      request: new Request(requestA.request),
      response: Response.json(
        {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'You have reached your weekly usage limit.',
          },
        },
        { status: 429, headers: { 'retry-after': '30' } },
      ),
    }
    await sessionHooks.get('http.response')!(responseA)
    const bodyA = (await responseA.response.json()) as {
      error: { message: string }
    }
    expect(bodyA.error.message).toContain(
      `active=${describeConnection(connectionA)}`,
    )
    expect(bodyA.error.message).not.toContain(describeConnection(connectionB))
    expect(responseA.response.headers.get('x-should-retry')).toBe('false')

    const responseB: any = {
      model,
      request: new Request(requestB.request),
      response: Response.json(
        {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'Rate limited. Please try again later.',
          },
        },
        { status: 429, headers: { 'retry-after': '2' } },
      ),
    }
    await sessionHooks.get('http.response')!(responseB)
    const bodyB = (await responseB.response.json()) as {
      error: { message: string }
    }
    expect(bodyB.error.message).toContain(
      `active=${describeConnection(connectionB)}`,
    )
    expect(bodyB.error.message).not.toContain(describeConnection(connectionA))
    expect(responseB.response.headers.get('x-should-retry')).toBeNull()

    expect(ctx.integration.connection.active).toHaveBeenCalledTimes(2)
    expect(ctx.integration.connection.resolve).toHaveBeenCalledTimes(2)
    expect(ctx.integration.connection.resolve).toHaveBeenNthCalledWith(
      1,
      connectionA,
    )
    expect(ctx.integration.connection.resolve).toHaveBeenNthCalledWith(
      2,
      connectionB,
    )
  })

  test('vetoes only classified Anthropic subscription retries', async () => {
    const { ctx, sessionHooks } = createMockContext()
    await plugin.setup(ctx as any)
    const retryHook = sessionHooks.get('retry')!
    const subscription: any = {
      model: { providerID: 'anthropic', modelID: 'claude-test' },
      error: {
        type: 'RateLimit',
        message:
          '[anthropic-auth category=subscription-usage; active=Anthropic 3 [connection af60761e26]] Usage limit reached.',
        status: 429,
      },
      attempt: 0,
      decision: { retry: true, delay: 1000 },
    }
    const transient = {
      ...subscription,
      error: {
        ...subscription.error,
        message:
          '[anthropic-auth category=transient-rate-limit; active=Anthropic 3 [connection af60761e26]] Rate limited.',
      },
      decision: { retry: true, delay: 2000 },
    }
    const otherProvider = {
      ...subscription,
      model: { providerID: 'openai', modelID: 'gpt-test' },
      decision: { retry: true, delay: 3000 },
    }

    await retryHook(subscription)
    await retryHook(transient)
    await retryHook(otherProvider)

    expect(subscription.decision).toEqual({ retry: false })
    expect(transient.decision).toEqual({ retry: true, delay: 2000 })
    expect(otherProvider.decision).toEqual({ retry: true, delay: 3000 })
    expect(ctx.integration.connection.active).not.toHaveBeenCalled()
    expect(ctx.integration.connection.resolve).not.toHaveBeenCalled()
  })
})
