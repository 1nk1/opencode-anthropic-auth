import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import plugin from '../index'

/**
 * Minimal mock of the OpenCode v2 promise plugin `Context`, covering only
 * the surface this plugin actually uses: `integration`, `catalog`,
 * `session`, and `event`.
 */
function createMockContext() {
  const integrationMethods: Array<Record<string, unknown>> = []
  const sessionHooks = new Map<string, (event: any) => Promise<void> | void>()
  let catalogTransformCb: ((draft: any) => void) | undefined

  const eventQueue: any[] = []
  let notifyEvent: (() => void) | null = null
  let subscribeAbortSignal: AbortSignal | undefined

  const ctx = {
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
    catalog: {
      transform: mock(async (cb: (draft: any) => void) => {
        catalogTransformCb = cb
        return { dispose: mock(async () => {}) }
      }),
      reload: mock(async () => {}),
    },
    session: {
      hook: mock(
        async (name: string, cb: (event: any) => Promise<void> | void) => {
          sessionHooks.set(name, cb)
          return { dispose: mock(async () => {}) }
        },
      ),
    },
    event: {
      subscribe: mock((opts?: { signal?: AbortSignal }) => {
        subscribeAbortSignal = opts?.signal
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                while (eventQueue.length === 0) {
                  if (subscribeAbortSignal?.aborted) {
                    return { done: true, value: undefined }
                  }
                  await new Promise<void>((resolve) => {
                    notifyEvent = resolve
                  })
                }
                return { done: false, value: eventQueue.shift() }
              },
            }
          },
        }
      }),
    },
  }

  return {
    ctx,
    integrationMethods,
    sessionHooks,
    getCatalogTransform: () => catalogTransformCb,
    pushEvent(event: unknown) {
      eventQueue.push(event)
      notifyEvent?.()
      notifyEvent = null
    },
  }
}

function createCatalogDraft(models: Record<string, { cost: unknown }>) {
  const modelsMap = new Map(Object.entries(models))
  return {
    provider: {
      get: mock((id: string) =>
        id === 'anthropic' ? { provider: {}, models: modelsMap } : undefined,
      ),
    },
    model: {
      update: mock(
        (
          _providerID: string,
          modelID: string,
          updater: (model: { cost: unknown }) => void,
        ) => {
          const model = modelsMap.get(modelID)
          if (model) updater(model)
        },
      ),
    },
    modelsMap,
  }
}

describe('default export', () => {
  test('is a v2 plugin definition with an id and a setup function', () => {
    expect(plugin.id).toBe('ex-machina.anthropic-auth')
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

    expect(authorization.callback('not-a-valid-callback')).rejects.toThrow(
      /Failed to exchange/,
    )
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

      expect(
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
})

describe('catalog cost transform', () => {
  test('zeros Anthropic model costs when OAuth is active', async () => {
    const { ctx, getCatalogTransform } = createMockContext()
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
    const draft = createCatalogDraft({
      'claude-3': { cost: [{ input: 3, output: 15 }] },
    })
    getCatalogTransform()!(draft)

    expect(draft.modelsMap.get('claude-3')!.cost).toEqual([])
  })

  test('leaves Anthropic model costs untouched when OAuth is not active', async () => {
    const { ctx, getCatalogTransform } = createMockContext()
    await plugin.setup(ctx as any)

    const draft = createCatalogDraft({
      'claude-3': { cost: [{ input: 3, output: 15 }] },
    })
    getCatalogTransform()!(draft)

    expect(draft.modelsMap.get('claude-3')!.cost).toEqual([
      { input: 3, output: 15 },
    ])
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
        headers: { 'x-api-key': 'my-access-token' },
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
    expect(rewritten.headers.get('anthropic-beta')).toContain(
      'oauth-2025-04-20',
    )
    expect(rewritten.url).toContain('beta=true')

    const parsedBody = JSON.parse(await rewritten.text())
    expect(parsedBody.tools[0].name).toBe('mcp_Bash')
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
})

describe('session http.response hook', () => {
  test('strips the tool prefix from streaming responses for an active OAuth connection', async () => {
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

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"content_block":{"type":"tool_use","name":"mcp_bash"}}\n\n',
          ),
        )
        controller.close()
      },
    })
    const originalResponse = new Response(stream, { status: 200 })
    const event: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages'),
      response: originalResponse,
    }
    await sessionHooks.get('http.response')!(event)

    expect(event.response).not.toBe(originalResponse)
    const text = await event.response.text()
    expect(text).toContain('"name": "bash"')
    expect(text).not.toContain('mcp_bash')
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
})

describe('integration.connection.updated event handling', () => {
  let originalConsoleWarn: typeof console.warn

  beforeEach(() => {
    originalConsoleWarn = console.warn
    console.warn = mock(() => {})
  })

  afterEach(() => {
    console.warn = originalConsoleWarn
  })

  test('reloads the catalog when the anthropic connection changes activation state', async () => {
    const { ctx, pushEvent } = createMockContext()
    let active = false
    ;(ctx.integration.connection.active as any).mockImplementation(async () =>
      active ? { id: 'conn-1' } : undefined,
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
    expect(ctx.catalog.reload).not.toHaveBeenCalled()

    active = true
    pushEvent({
      type: 'integration.connection.updated',
      data: { integrationID: 'anthropic' },
    })

    await Bun.sleep(0)
    await Bun.sleep(0)

    expect(ctx.catalog.reload).toHaveBeenCalledTimes(1)
  })

  test('ignores connection updates for other integrations', async () => {
    const { ctx, pushEvent } = createMockContext()
    await plugin.setup(ctx as any)

    pushEvent({
      type: 'integration.connection.updated',
      data: { integrationID: 'openai' },
    })
    await Bun.sleep(0)
    await Bun.sleep(0)

    expect(ctx.catalog.reload).not.toHaveBeenCalled()
  })
})

describe('setup cleanup', () => {
  test('returns a cleanup function that aborts the event subscription', async () => {
    const { ctx } = createMockContext()
    const cleanup = await plugin.setup(ctx as any)

    expect(cleanup).toBeFunction()
    expect(() => (cleanup as () => void)()).not.toThrow()
  })
})
