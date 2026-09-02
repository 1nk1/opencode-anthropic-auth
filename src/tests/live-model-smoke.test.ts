import { describe, expect, test } from 'bun:test'
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertSafePreflight,
  buildProbePluginSource,
  buildSmokeResult,
  type CommandResult,
  classifySmokeResult,
  cleanupSmokeSessions,
  hasActivePlugin,
  hasOAuthMethod,
  isBlockingSmokeStatus,
  livePluginEnvironment,
  MAX_MODEL_ID_BYTES,
  MAX_PREFLIGHT_RESULT_BYTES,
  parseAnthropicModelResponse,
  parseAnthropicModels,
  parseExactSessionIDs,
  parsePreflightResult,
  parsePrivateServerURL,
  readBounded,
  readBoundedUtf8File,
  runCommand,
  writePrivateReport,
} from '../../scripts/live-model-smoke'

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: '',
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  }
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch {
      await Bun.sleep(10)
    }
  }
  throw new Error(`Timed out waiting for ${path}`)
}

async function runSignalCleanupCase(signal: 'SIGINT' | 'SIGTERM') {
  const directory = await mkdtemp(join(process.cwd(), '.signal-test-'))
  const binary = join(directory, 'fake-opencode.ts')
  const modelMarker = join(directory, 'model.json')
  const terminatedMarker = join(directory, 'model-terminated')
  const cleanupMarker = join(directory, 'cleanup-called')
  try {
    await Bun.write(
      binary,
      `#!/usr/bin/env bun
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const command = args[0]
if (command === 'serve') {
  console.log('server listening on http://127.0.0.1:42423')
  const stop = () => process.exit(0)
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  setInterval(() => {}, 1_000)
} else if (command === 'auth') {
  const result = {
    pluginID: null,
    pluginActive: false,
    oauthMethodID: null,
    oauthMethodRegistered: false,
    activeCredentialType: 'oauth',
    activeMethodID: 'claude-max',
  }
  const path = join(process.cwd(), 'preflight.json')
  writeFileSync(path, JSON.stringify(result), { mode: 0o600 })
  chmodSync(path, 0o600)
  console.log('[]')
} else if (command === 'api' && args.includes('/api/plugin')) {
  console.log(JSON.stringify({ data: [{ id: 'ink1.anthropic-auth', state: { status: 'active' } }] }))
} else if (command === 'api' && args.includes('/api/integration/anthropic')) {
  console.log(JSON.stringify({ data: { id: 'anthropic', methods: [{ id: 'claude-max', type: 'oauth' }] } }))
} else if (command === 'api' && args.includes('/api/model')) { console.log(JSON.stringify({ data: [{ providerID: 'anthropic', modelID: 'fake-model' }] }))
} else if (command === 'api' && args.some((arg) => arg.startsWith('/api/session'))) {
  writeFileSync(process.env.CLEANUP_MARKER, 'called')
  console.log(JSON.stringify({ data: [] }))
} else if (command === 'models') {
  console.log('anthropic/fake-model')
} else if (command === 'run') {
  writeFileSync(process.env.MODEL_MARKER, JSON.stringify({ pid: process.pid, cwd: process.cwd() }))
  const stop = () => {
    writeFileSync(process.env.TERMINATED_MARKER, 'terminated')
    process.exit(143)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  setInterval(() => {}, 1_000)
 } else {
   console.error('unexpected fake command', JSON.stringify(args))
   process.exit(2)
 }
`,
    )

    await chmod(binary, 0o700)

    const child = Bun.spawn(['bun', 'scripts/live-model-smoke.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ANTHROPIC_LIVE_SMOKE: '1',
        ANTHROPIC_LIVE_CWD: directory,
        ANTHROPIC_LIVE_DELAY_MS: '1',
        ANTHROPIC_LIVE_TIMEOUT_MS: '10000',
        CLEANUP_MARKER: cleanupMarker,
        MODEL_MARKER: modelMarker,
        OPENCODE_BIN: binary,
        TERMINATED_MARKER: terminatedMarker,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    await waitForFile(modelMarker)
    const model = JSON.parse(await readFile(modelMarker, 'utf8')) as {
      cwd: string
      pid: number
    }
    child.kill(signal)
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(10_000).then(() => {
        child.kill('SIGKILL')
        throw new Error(`Smoke process did not exit after ${signal}`)
      }),
    ])

    expect(exitCode).not.toBe(0)
    await waitForFile(terminatedMarker)
    await waitForFile(cleanupMarker)
    expect(Bun.spawnSync(['kill', '-0', String(model.pid)]).exitCode).not.toBe(
      0,
    )
    await expect(access(model.cwd)).rejects.toThrow()
    expect(
      (await readdir(directory)).filter((entry) =>
        entry.startsWith('.anthropic-live-smoke-'),
      ),
    ).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function writeCommandScript(
  directory: string,
  source: string,
): Promise<string> {
  const path = join(directory, 'command.ts')
  await Bun.write(path, `#!/usr/bin/env bun\n${source}\n`)
  await chmod(path, 0o700)
  return path
}

async function runFakeSmoke(
  mode: string,
  extraEnv: Record<string, string> = {},
): Promise<{
  child: ReturnType<typeof Bun.spawn>
  directory: string
  modelMarker: string
  runMarker: string
  serverMarker: string
  cleanupMarker: string
  helperMarker: string
  titleMarker: string
  cleanupTitleMarker: string
  deletedMarker: string
  reportMarker: string
}> {
  const directory = await mkdtemp(join(process.cwd(), '.preflight-test-'))
  const modelMarker = join(directory, 'models-called')
  const runMarker = join(directory, 'run-called')
  const serverMarker = join(directory, 'server.pid')
  const cleanupMarker = join(directory, 'cleanup-called')
  const helperMarker = join(directory, 'server-helper.pid')
  const titleMarker = join(directory, 'run-title')
  const cleanupTitleMarker = join(directory, 'cleanup-title')
  const deletedMarker = join(directory, 'deleted-sessions')
  const reportMarker = join(directory, 'report.json')
  const binary = await writeCommandScript(
    directory,
    `import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
 const args = process.argv.slice(2)
 const command = args[0]
 if (command === 'serve') { if (process.env.FORK_SERVER_HELPER) { const helper = Bun.spawn(['bun', '-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdout: 'inherit', stderr: 'inherit' }); writeFileSync(process.env.HELPER_MARKER, String(helper.pid)) }; writeFileSync(process.env.SERVER_MARKER, String(process.pid)); const startupMode = process.env.FAKE_STARTUP_MODE; if (startupMode === 'malformed') console.log('not a server URL'); else if (startupMode === 'non-loopback') console.log('server listening on http://0.0.0.0:42423'); else if (startupMode === 'timeout') {} else if (startupMode === 'overflow') process.stdout.write('x'.repeat(4097)); else console.log('server listening on http://127.0.0.1:42423'); process.on('SIGTERM', () => process.exit(0)); process.on('SIGINT', () => process.exit(0)); setInterval(() => {}, 1000) }
else if (command === 'auth') { writeFileSync('preflight.json', JSON.stringify({ pluginID: null, pluginActive: false, oauthMethodID: null, oauthMethodRegistered: false, activeCredentialType: process.env.FAKE_MODE === 'api-key' ? 'key' : 'oauth', activeMethodID: process.env.FAKE_MODE === 'api-key' ? null : 'claude-max' })); console.log('[]') }
 else if (command === 'api' && (args.includes('/api/plugin') || args.includes('/api/integration/anthropic'))) { const path = 'preflight-api-attempts'; const attempts = (existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0) + 1; writeFileSync(path, String(attempts)); const delayed = process.env.FAKE_MODE === 'delayed' && attempts < 3; if (process.env.FAKE_MODE === 'delayed') { try { unlinkSync('preflight.json') } catch {} if (!delayed) writeFileSync('preflight.json', JSON.stringify({ pluginID: null, pluginActive: false, oauthMethodID: null, oauthMethodRegistered: false, activeCredentialType: 'oauth', activeMethodID: 'claude-max' })) } if (args.includes('/api/plugin')) console.log(JSON.stringify({ data: [{ id: 'ink1.anthropic-auth', state: { status: process.env.FAKE_MODE === 'inactive' || process.env.FAKE_MODE === 'never-ready' || delayed ? 'failed' : 'active' } }] })); else console.log(JSON.stringify({ data: { id: 'anthropic', methods: process.env.FAKE_MODE === 'missing-oauth' || process.env.FAKE_MODE === 'never-ready' || delayed ? [{ id: 'key', type: 'key' }] : [{ id: 'claude-max', type: 'oauth' }] } })) }
 else if (command === 'api' && args.includes('/api/model')) { const path = 'catalog-attempts'; const attempts = (existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0) + 1; writeFileSync(path, String(attempts)); if ((process.env.FAKE_MODE === 'catalog-delayed' && attempts < 3) || process.env.FAKE_MODE === 'catalog-empty') console.log(JSON.stringify({ data: [] })); else if (process.env.FAKE_MODE === 'catalog-malformed') console.log('{'); else if (process.env.FAKE_MODE === 'catalog-truncated') process.stdout.write(JSON.stringify({ data: [{ providerID: 'anthropic', modelID: 'fake' }] }) + 'x'.repeat(1024 * 1024 + 1)); else if (process.env.FAKE_MODE === 'catalog-oversized') console.log(JSON.stringify({ data: Array.from({ length: 257 }, (_, index) => ({ providerID: 'anthropic', modelID: 'fake-' + index })) })); else console.log(JSON.stringify({ data: [{ providerID: 'openai', modelID: 'gpt' }, { providerID: 'anthropic', modelID: 'fake-model' }, { providerID: 'anthropic', modelID: 'fake-model' }] })) }
 else if (command === 'api' && args.some((arg) => arg.startsWith('/api/session'))) { const path = args.find((arg) => arg.startsWith('/api/session')); if (args.includes('get')) { const title = new URL(path, 'http://localhost').searchParams.get('search'); writeFileSync(process.env.CLEANUP_MARKER, 'called'); writeFileSync(process.env.CLEANUP_TITLE_MARKER, title ?? ''); const runTitle = readFileSync(process.env.TITLE_MARKER, 'utf8'); console.log(JSON.stringify({ data: [{ id: 'ses_matching', title: runTitle }, { id: 'ses_unrelated', title: 'unrelated-session' }], cursor: { next: null } })) } else { const id = path.slice('/api/session/'.length); appendFileSync(process.env.DELETED_MARKER, id + '\\n'); console.log(JSON.stringify({ data: [] })) } }
else if (command === 'models') { writeFileSync(process.env.MODEL_MARKER, 'called'); if (process.env.FAKE_TRUNCATED_MODELS) { process.on('SIGTERM', () => process.exit(0)); process.stdout.write('anthropic/fake-model\\n' + 'x'.repeat(1024 * 1024 + 1)); setInterval(() => {}, 1000) } else console.log(process.env.FAKE_DELAY ? 'anthropic/fake-model\\nanthropic/fake-model-2' : 'anthropic/fake-model') }
 else if (command === 'run') { writeFileSync(process.env.RUN_MARKER, 'called'); writeFileSync(process.env.TITLE_MARKER, args[args.indexOf('--title') + 1] ?? ''); if (process.env.FAKE_RUN_FAILED) { console.error('fake model failure'); process.exit(7) } else console.log('MODEL_SMOKE_OK') }
else process.exit(2)`,
  )
  const child = Bun.spawn(['bun', 'scripts/live-model-smoke.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ANTHROPIC_LIVE_SMOKE: '1',
      ANTHROPIC_LIVE_CWD: directory,
      ANTHROPIC_LIVE_DELAY_MS: '1',
      ANTHROPIC_LIVE_TIMEOUT_MS: '2000',
      FAKE_MODE: mode,
      CLEANUP_MARKER: cleanupMarker,
      HELPER_MARKER: helperMarker,
      MODEL_MARKER: modelMarker,
      RUN_MARKER: runMarker,
      SERVER_MARKER: serverMarker,
      TITLE_MARKER: titleMarker,
      CLEANUP_TITLE_MARKER: cleanupTitleMarker,
      DELETED_MARKER: deletedMarker,
      ANTHROPIC_LIVE_REPORT: reportMarker,
      OPENCODE_BIN: binary,
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    child,
    directory,
    modelMarker,
    runMarker,
    serverMarker,
    cleanupMarker,
    helperMarker,
    titleMarker,
    cleanupTitleMarker,
    deletedMarker,
    reportMarker,
  }
}

describe('live model discovery', () => {
  test('returns sorted, unique Anthropic model IDs only', () => {
    expect(
      parseAnthropicModels(`
        openai/gpt-5
        anthropic/claude-opus-5
        anthropic/claude-haiku-4-5
        anthropic/claude-opus-5
        malformed anthropic/claude
      `),
    ).toEqual(['anthropic/claude-haiku-4-5', 'anthropic/claude-opus-5'])
  })

  test('rejects an unbounded Anthropic catalog before requests', () => {
    const output = Array.from(
      { length: 257 },
      (_, index) => `anthropic/model-${index}`,
    ).join('\n')

    expect(() => parseAnthropicModels(output)).toThrow(
      'OpenCode returned 257 Anthropic models; maximum is 256',
    )
  })

  test('rejects an oversized individual model ID before requests', () => {
    expect(() =>
      parseAnthropicModels(`anthropic/${'x'.repeat(MAX_MODEL_ID_BYTES)}`),
    ).toThrow(`Anthropic model ID above the ${MAX_MODEL_ID_BYTES} byte limit`)
  })

  test('parses the authenticated model API envelope', () => {
    expect(
      parseAnthropicModelResponse(
        JSON.stringify({
          location: {},
          data: [
            { providerID: 'openai', modelID: 'gpt' },
            { providerID: 'anthropic', modelID: 'z' },
            { providerID: 'anthropic', modelID: 'a' },
            { providerID: 'anthropic', modelID: 'a' },
          ],
        }),
      ),
    ).toEqual(['anthropic/a', 'anthropic/z'])
  })

  test.each(['malformed', 'empty'])('rejects a %s model envelope', (kind) => {
    const output = kind === 'empty' ? JSON.stringify({ data: [] }) : '{'
    expect(() => parseAnthropicModelResponse(output)).toThrow()
  })

  test('rejects an oversized model catalog', () => {
    expect(() =>
      parseAnthropicModelResponse(
        JSON.stringify({
          data: Array.from({ length: 257 }, (_, index) => ({
            providerID: 'anthropic',
            modelID: `model-${index}`,
          })),
        }),
      ),
    ).toThrow('maximum is 256')
  })

  test.each([
    '',
    '   ',
    'model id',
    'model\u0000id',
    'model\u001bid',
  ])('rejects invalid Anthropic model ID %j', (modelID) => {
    expect(() =>
      parseAnthropicModelResponse(
        JSON.stringify({
          data: [{ providerID: 'anthropic', modelID }],
        }),
      ),
    ).toThrow('Invalid Anthropic model ID')
  })
})

describe('live model preflight', () => {
  const valid = {
    pluginID: 'ink1.anthropic-auth',
    pluginActive: true,
    oauthMethodID: 'claude-max',
    oauthMethodRegistered: true,
    activeCredentialType: 'oauth',
    activeMethodID: 'claude-max',
  }

  test('accepts only the required plugin and active OAuth method', () => {
    const parsed = parsePreflightResult(valid)
    expect(() => assertSafePreflight(parsed)).not.toThrow()
  })

  test('rejects a missing plugin before model requests', () => {
    expect(() =>
      assertSafePreflight({ ...valid, pluginID: null, pluginActive: false }),
    ).toThrow('Required plugin ink1.anthropic-auth is not active')
  })

  test('requires an active plugin entry from the completed plugin list', () => {
    expect(
      hasActivePlugin(
        JSON.stringify({
          data: [
            {
              id: 'ink1.anthropic-auth',
              state: { status: 'active' },
            },
          ],
        }),
        'ink1.anthropic-auth',
      ),
    ).toBe(true)
    expect(
      hasActivePlugin(
        JSON.stringify({
          data: [
            {
              id: 'ink1.anthropic-auth',
              state: { status: 'failed' },
            },
          ],
        }),
        'ink1.anthropic-auth',
      ),
    ).toBe(false)
    expect(
      hasActivePlugin(
        JSON.stringify({
          data: [{ id: 'ink1.anthropic-auth' }],
        }),
        'ink1.anthropic-auth',
      ),
    ).toBe(false)
  })

  test('rejects API-key and wrong OAuth connections', () => {
    expect(() =>
      assertSafePreflight({
        ...valid,
        activeCredentialType: 'key',
        activeMethodID: null,
      }),
    ).toThrow('Active Anthropic connection is not using claude-max OAuth')
    expect(() =>
      assertSafePreflight({ ...valid, activeMethodID: 'other-oauth' }),
    ).toThrow('Active Anthropic connection is not using claude-max OAuth')
  })

  test('requires the exact registered Anthropic OAuth method', () => {
    const response = JSON.stringify({
      data: {
        id: 'anthropic',
        methods: [
          { id: 'key', type: 'key' },
          { id: 'claude-max', type: 'oauth' },
        ],
      },
    })

    expect(hasOAuthMethod(response, 'anthropic', 'claude-max')).toBe(true)
    expect(hasOAuthMethod(response, 'anthropic', 'other-oauth')).toBe(false)
    expect(() => hasOAuthMethod(response, 'openai', 'claude-max')).toThrow(
      'Invalid integration response',
    )
  })

  test('probe source serializes only allowlisted credential metadata', () => {
    const source = buildProbePluginSource('/private/preflight.json')

    expect(source).toContain("from 'node:fs/promises'")
    expect(source).not.toContain('Bun.write')
    expect(source).toContain("credential?.type === 'oauth'")
    expect(source).toContain('credential.methodID')
    expect(source).not.toContain('integration.transform')
    expect(source).not.toContain('credential.access')
    expect(source).not.toContain('credential.refresh')
    expect(source).not.toContain('credential.key')
  })

  test('uses the exact configured plugin for standalone model commands', () => {
    const previous = process.env.ANTHROPIC_LIVE_PLUGIN
    try {
      process.env.ANTHROPIC_LIVE_PLUGIN = 'file:///private/plugin'
      expect(livePluginEnvironment()).toEqual({
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          plugins: ['file:///private/plugin'],
        }),
      })
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_LIVE_PLUGIN
      else process.env.ANTHROPIC_LIVE_PLUGIN = previous
    }
  })

  test('bounds and strictly decodes the private preflight result', async () => {
    const directory = await mkdtemp(
      join(process.cwd(), '.preflight-file-test-'),
    )
    const path = join(directory, 'preflight.json')
    try {
      await Bun.write(path, 'x'.repeat(MAX_PREFLIGHT_RESULT_BYTES + 1))
      await expect(readBoundedUtf8File(path)).rejects.toThrow(
        `File exceeds the ${MAX_PREFLIGHT_RESULT_BYTES} byte limit`,
      )
      await Bun.write(path, Uint8Array.from([0xc3, 0x28]))
      await expect(readBoundedUtf8File(path)).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('releases bounded stream readers after completion and cancellation', async () => {
    const completed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('ok'))
        controller.close()
      },
    })
    expect(await readBounded(completed, 8, () => {})).toEqual({
      text: 'ok',
      truncated: false,
    })
    completed.getReader().releaseLock()

    let limited = false
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('too large'))
      },
    })
    expect(
      await readBounded(oversized, 3, () => {
        limited = true
      }),
    ).toEqual({ text: 'too', truncated: true })
    expect(limited).toBe(true)
    oversized.getReader().releaseLock()
  })

  test('accepts only a loopback private server URL', () => {
    expect(
      parsePrivateServerURL('server listening on http://127.0.0.1:42423'),
    ).toBe('http://127.0.0.1:42423')
    expect(() =>
      parsePrivateServerURL('server listening on http://0.0.0.0:42423'),
    ).toThrow('Private OpenCode server is not bound to loopback')
    expect(() => parsePrivateServerURL('server password secret')).toThrow(
      'Invalid private server output',
    )
  })
})

describe('live model result classification', () => {
  test('passes only when the sentinel is present', () => {
    expect(
      classifySmokeResult(result({ exitCode: 0, stdout: 'MODEL_SMOKE_OK' })),
    ).toBe('passed')
    expect(classifySmokeResult(result({ exitCode: 0, stdout: 'hello' }))).toBe(
      'unexpected_output',
    )
  })

  test('classifies unsupported models', () => {
    expect(
      classifySmokeResult(result({ stderr: 'invalid model: claude-future' })),
    ).toBe('unsupported')
  })

  test('classifies subscription blocks', () => {
    expect(
      classifySmokeResult(
        result({ stderr: "You're out of extra usage. Add more." }),
      ),
    ).toBe('subscription_blocked')
  })

  test('classifies fast models that require usage credits', () => {
    expect(
      classifySmokeResult(
        result({ stderr: 'Usage credits are required for fast mode.' }),
      ),
    ).toBe('usage_credits_required')
  })

  test('classifies rate limits', () => {
    expect(classifySmokeResult(result({ stderr: 'HTTP 429' }))).toBe(
      'rate_limited',
    )
  })

  test('classifies authentication failures', () => {
    expect(
      classifySmokeResult(result({ stderr: 'HTTP 401 Unauthorized' })),
    ).toBe('authentication_failed')
  })

  test('classifies provider failures and timeouts', () => {
    expect(classifySmokeResult(result({ stderr: 'HTTP 529 overloaded' }))).toBe(
      'server_error',
    )
    expect(classifySmokeResult(result({ timedOut: true }))).toBe('timed_out')
  })

  test('never passes a failed command or sentinel mixed with provider errors', () => {
    for (const output of ['HTTP 401', 'HTTP 429', 'HTTP 500']) {
      expect(
        classifySmokeResult(
          result({ exitCode: 1, stdout: 'MODEL_SMOKE_OK', stderr: output }),
        ),
      ).not.toBe('passed')
      expect(
        classifySmokeResult(
          result({ exitCode: 0, stdout: output, stderr: 'MODEL_SMOKE_OK' }),
        ),
      ).not.toBe('passed')
    }
    expect(
      classifySmokeResult(result({ exitCode: 1, stdout: 'MODEL_SMOKE_OK' })),
    ).toBe('failed')
    expect(
      classifySmokeResult(
        result({
          exitCode: 0,
          stdout: 'MODEL_SMOKE_OK',
          stdoutTruncated: true,
        }),
      ),
    ).toBe('failed')
  })

  test('classifies equivalent diagnostics from stdout and stderr identically', () => {
    for (const [diagnostic, expected] of [
      ['HTTP 401', 'authentication_failed'],
      ['HTTP 429', 'rate_limited'],
      ['HTTP 500', 'server_error'],
    ] as const) {
      expect(classifySmokeResult(result({ stdout: diagnostic }))).toBe(expected)
      expect(classifySmokeResult(result({ stderr: diagnostic }))).toBe(expected)
    }
  })

  test('treats paid fast-mode restrictions as non-blocking', () => {
    expect(isBlockingSmokeStatus('passed')).toBe(false)
    expect(isBlockingSmokeStatus('usage_credits_required')).toBe(false)
    expect(isBlockingSmokeStatus('unsupported')).toBe(true)
  })
})

describe('live model report privacy', () => {
  const raw = result({
    stdout: 'provider output with access_token=secret',
    stderr: 'arbitrary stderr',
  })

  test('excludes all child output by default', () => {
    const report = buildSmokeResult('anthropic/test', 'failed', 10, raw, false)

    expect(report).toEqual({
      model: 'anthropic/test',
      status: 'failed',
      latencyMs: 10,
    })
    expect(JSON.stringify(report)).not.toContain('secret')
    expect(JSON.stringify(report)).not.toContain('arbitrary stderr')
  })

  test('includes raw output only in explicit unsafe debug mode', () => {
    const report = buildSmokeResult('anthropic/test', 'failed', 10, raw, true)

    expect(report.debug?.stdout).toContain('access_token=secret')
    expect(report.debug?.stderr).toBe('arbitrary stderr')
  })

  test('bounds aggregate unsafe output retained per model', () => {
    const report = buildSmokeResult(
      'anthropic/test',
      'failed',
      10,
      result({ stdout: 'a'.repeat(20_000), stderr: 'b'.repeat(20_000) }),
      true,
    )
    const retained = new TextEncoder().encode(
      `${report.debug?.stdout ?? ''}${report.debug?.stderr ?? ''}`,
    )

    expect(retained.byteLength).toBeLessThanOrEqual(16 * 1024)
    expect(report.debug?.stdoutTruncated).toBe(true)
    expect(report.debug?.stderrTruncated).toBe(true)
  })

  test('writes reports privately without following the destination symlink', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.report-test-'))
    const target = join(directory, 'target.json')
    const report = join(directory, 'report.json')
    try {
      await Bun.write(target, 'do not replace')
      await symlink(target, report)

      await writePrivateReport(report, '{"safe":true}\n')

      expect(await readFile(target, 'utf8')).toBe('do not replace')
      expect(await readFile(report, 'utf8')).toBe('{"safe":true}\n')
      expect((await lstat(report)).isSymbolicLink()).toBe(false)
      expect((await lstat(report)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('repairs permissions when overwriting an existing report', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.report-mode-test-'))
    const report = join(directory, 'report.json')
    try {
      await Bun.write(report, 'old')
      await chmod(report, 0o644)
      await writePrivateReport(report, 'new\n')
      expect(await readFile(report, 'utf8')).toBe('new\n')
      expect((await lstat(report)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('live model session cleanup', () => {
  test('selects only exact-title sessions with valid IDs', () => {
    const output = JSON.stringify({
      data: [
        { id: 'ses_exact', title: 'anthropic-live-smoke:run:1' },
        { id: 'ses_other', title: 'anthropic-live-smoke:run:10' },
        { id: '../unsafe', title: 'anthropic-live-smoke:run:1' },
      ],
      cursor: {},
    })

    expect(parseExactSessionIDs(output, 'anthropic-live-smoke:run:1')).toEqual([
      'ses_exact',
    ])
  })

  test('lists and deletes every exact smoke-test session', async () => {
    const calls: string[][] = []
    const runner = async (command: string[]): Promise<CommandResult> => {
      calls.push(command)
      if (command.some((argument) => argument.startsWith('/api/session?'))) {
        return result({
          exitCode: 0,
          stdout: JSON.stringify({
            data: [
              { id: 'ses_one', title: 'anthropic-live-smoke:run:1' },
              { id: 'ses_two', title: 'anthropic-live-smoke:run:1' },
            ],
          }),
        })
      }
      return result({ exitCode: 0 })
    }

    await cleanupSmokeSessions(
      runner,
      'opencode2',
      '/sandbox',
      1000,
      'anthropic-live-smoke:run:1',
    )

    expect(calls).toHaveLength(3)
    expect(calls[1]?.at(-1)).toBe('/api/session/ses_one')
    expect(calls[2]?.at(-1)).toBe('/api/session/ses_two')
  })

  test('fails closed when cleanup times out', async () => {
    const runner = async (): Promise<CommandResult> =>
      result({ timedOut: true })

    await expect(
      cleanupSmokeSessions(
        runner,
        'opencode2',
        '/sandbox',
        1000,
        'anthropic-live-smoke:run:1',
      ),
    ).rejects.toThrow('Unable to clean up smoke-test session')
  })

  test('rejects a truncated cleanup listing before parsing it', async () => {
    const runner = async (): Promise<CommandResult> =>
      result({
        exitCode: 0,
        stdout: JSON.stringify({ data: [], cursor: { next: null } }),
        stdoutTruncated: true,
      })

    await expect(
      cleanupSmokeSessions(runner, 'opencode2', '/sandbox', 1000, 'smoke'),
    ).rejects.toThrow('Unable to clean up smoke-test session')
  })

  test('follows cursors and rejects a repeated cursor', async () => {
    const cursors: string[] = []
    const runner = async (command: string[]): Promise<CommandResult> => {
      const path = command.find((argument) =>
        argument.startsWith('/api/session?'),
      )
      const cursor = path
        ? new URL(path, 'http://localhost').searchParams.get('cursor')
        : null
      if (path) {
        cursors.push(cursor ?? '')
        return result({
          exitCode: 0,
          stdout: JSON.stringify({
            data: [{ id: `ses_${cursors.length}`, title: 'smoke' }],
            cursor: { next: 'same' },
          }),
        })
      }
      return result({ exitCode: 0 })
    }

    await expect(
      cleanupSmokeSessions(runner, 'opencode2', '/sandbox', 1000, 'smoke'),
    ).rejects.toThrow('Repeated session cleanup cursor')
    expect(cursors).toEqual(['', 'same'])
  })

  test('deletes exact-title sessions returned across multiple pages', async () => {
    const deleted: string[] = []
    let page = 0
    const runner = async (command: string[]): Promise<CommandResult> => {
      const deletePath = command.find((argument) =>
        argument.startsWith('/api/session/ses_'),
      )
      if (deletePath) {
        deleted.push(deletePath.slice('/api/session/'.length))
        return result({ exitCode: 0 })
      }
      page += 1
      return result({
        exitCode: 0,
        stdout: JSON.stringify({
          data: [{ id: `ses_${page}`, title: 'smoke' }],
          cursor: { next: page === 1 ? 'next-page' : null },
        }),
      })
    }

    await cleanupSmokeSessions(runner, 'opencode2', '/sandbox', 1000, 'smoke')
    expect(page).toBe(2)
    expect(deleted).toEqual(['ses_1', 'ses_2'])
  })

  test('rejects cleanup pagination that exceeds the page bound', async () => {
    let pages = 0
    const runner = async (command: string[]): Promise<CommandResult> => {
      if (!command.some((argument) => argument.startsWith('/api/session?'))) {
        return result({ exitCode: 0 })
      }
      pages += 1
      return result({
        exitCode: 0,
        stdout: JSON.stringify({ data: [], cursor: { next: `page-${pages}` } }),
      })
    }
    await expect(
      cleanupSmokeSessions(runner, 'opencode2', '/sandbox', 1000, 'smoke'),
    ).rejects.toThrow('Too many session cleanup pages')
    expect(pages).toBe(10)
  })

  test('rejects more than 256 exact-title sessions before deleting any', async () => {
    let deletes = 0
    const runner = async (command: string[]): Promise<CommandResult> => {
      if (command.some((argument) => argument.startsWith('/api/session?'))) {
        return result({
          exitCode: 0,
          stdout: JSON.stringify({
            data: Array.from({ length: 257 }, (_, index) => ({
              id: `ses_${index}`,
              title: 'smoke',
            })),
            cursor: { next: null },
          }),
        })
      }
      deletes += 1
      return result({ exitCode: 0 })
    }

    await expect(
      cleanupSmokeSessions(runner, 'opencode2', '/sandbox', 1000, 'smoke'),
    ).rejects.toThrow('Too many smoke-test sessions')
    expect(deletes).toBe(0)
  })

  test('accepts exactly 256 exact-title sessions and deletes all of them', async () => {
    let deletes = 0
    const runner = async (command: string[]): Promise<CommandResult> => {
      if (command.some((argument) => argument.startsWith('/api/session?'))) {
        return result({
          exitCode: 0,
          stdout: JSON.stringify({
            data: Array.from({ length: 256 }, (_, index) => ({
              id: `ses_${index}`,
              title: 'smoke',
            })),
            cursor: { next: null },
          }),
        })
      }
      deletes += 1
      return result({ exitCode: 0 })
    }

    await cleanupSmokeSessions(runner, 'opencode2', '/sandbox', 1000, 'smoke')
    expect(deletes).toBe(256)
  })

  test('rejects a cross-page session overflow before deleting any', async () => {
    let page = 0
    let deletes = 0
    const runner = async (command: string[]): Promise<CommandResult> => {
      if (command.some((argument) => argument.startsWith('/api/session?'))) {
        page += 1
        const count = page === 1 ? 200 : 57
        return result({
          exitCode: 0,
          stdout: JSON.stringify({
            data: Array.from({ length: count }, (_, index) => ({
              id: `ses_${page}_${index}`,
              title: 'smoke',
            })),
            cursor: { next: page === 1 ? 'page-two' : null },
          }),
        })
      }
      deletes += 1
      return result({ exitCode: 0 })
    }

    await expect(
      cleanupSmokeSessions(runner, 'opencode2', '/sandbox', 1000, 'smoke'),
    ).rejects.toThrow('Too many smoke-test sessions')
    expect(page).toBe(2)
    expect(deletes).toBe(0)
  })

  test('enforces one aggregate cleanup deadline', async () => {
    let calls = 0
    const runner = async (): Promise<CommandResult> => {
      calls += 1
      await Bun.sleep(30)
      return result({
        exitCode: 0,
        stdout: JSON.stringify({
          data: [{ id: 'ses_one', title: 'smoke' }],
          cursor: { next: null },
        }),
      })
    }

    await expect(
      cleanupSmokeSessions(runner, 'opencode2', '/sandbox', 20, 'smoke'),
    ).rejects.toThrow('Timed out cleaning up smoke-test session')
    expect(calls).toBe(1)
  })
})

describe('live model signal cleanup', () => {
  test('terminates the active model and removes its sandbox on SIGINT', async () => {
    await runSignalCleanupCase('SIGINT')
  }, 15_000)

  test('terminates the active model and removes its sandbox on SIGTERM', async () => {
    await runSignalCleanupCase('SIGTERM')
  }, 15_000)
})

describe('live model fail-closed execution', () => {
  test.each([
    'malformed',
    'non-loopback',
    'timeout',
    'overflow',
  ])('fails closed when private server startup is %s', async (startupMode) => {
    const smoke = await runFakeSmoke('valid', {
      FAKE_STARTUP_MODE: startupMode,
      ANTHROPIC_LIVE_TIMEOUT_MS: '100',
    })
    try {
      expect(await smoke.child.exited).not.toBe(0)
      const serverPID = Number(await readFile(smoke.serverMarker, 'utf8'))
      expect(
        Bun.spawnSync(['kill', '-0', String(serverPID)]).exitCode,
      ).not.toBe(0)
      expect(
        (await readdir(smoke.directory)).filter((entry) =>
          entry.startsWith('.anthropic-live-smoke-'),
        ),
      ).toEqual([])
    } finally {
      await rm(smoke.directory, { recursive: true, force: true })
    }
  })

  test.each([
    'inactive',
    'missing-oauth',
    'api-key',
  ])('does not discover or run models when preflight is %s', async (mode) => {
    const smoke = await runFakeSmoke(mode)
    try {
      expect(await smoke.child.exited).not.toBe(0)
      const serverPID = Number(await readFile(smoke.serverMarker, 'utf8'))
      expect(
        Bun.spawnSync(['kill', '-0', String(serverPID)]).exitCode,
      ).not.toBe(0)
      await expect(access(smoke.modelMarker)).rejects.toThrow()
      await expect(access(smoke.runMarker)).rejects.toThrow()
      expect(
        (await readdir(smoke.directory)).filter((entry) =>
          entry.startsWith('.anthropic-live-smoke-'),
        ),
      ).toEqual([])
    } finally {
      await rm(smoke.directory, { recursive: true, force: true })
    }
  })

  test('polls until delayed plugin, integration, and result readiness', async () => {
    const smoke = await runFakeSmoke('delayed', {
      ANTHROPIC_LIVE_TIMEOUT_MS: '5000',
    })
    try {
      expect(await smoke.child.exited).toBe(0)
      await waitForFile(smoke.runMarker)
      expect(
        (await readdir(smoke.directory)).filter((entry) =>
          entry.startsWith('.anthropic-live-smoke-'),
        ),
      ).toEqual([])
    } finally {
      await rm(smoke.directory, { recursive: true, force: true })
    }
  }, 8_000)

  test('fails at the preflight deadline without process or sandbox leftovers', async () => {
    const smoke = await runFakeSmoke('never-ready', {
      ANTHROPIC_LIVE_TIMEOUT_MS: '100',
    })
    try {
      expect(await smoke.child.exited).not.toBe(0)
      const serverPID = Number(await readFile(smoke.serverMarker, 'utf8'))
      expect(
        Bun.spawnSync(['kill', '-0', String(serverPID)]).exitCode,
      ).not.toBe(0)
      await expect(access(smoke.modelMarker)).rejects.toThrow()
      expect(
        (await readdir(smoke.directory)).filter((entry) =>
          entry.startsWith('.anthropic-live-smoke-'),
        ),
      ).toEqual([])
    } finally {
      await rm(smoke.directory, { recursive: true, force: true })
    }
  }, 8_000)

  test('polls until the authenticated model catalog is ready', async () => {
    const smoke = await runFakeSmoke('catalog-delayed', {
      ANTHROPIC_LIVE_TIMEOUT_MS: '5000',
    })
    try {
      expect(await smoke.child.exited).toBe(0)
      await waitForFile(smoke.runMarker)
    } finally {
      await rm(smoke.directory, { recursive: true, force: true })
    }
  }, 8_000)

  test.each([
    'catalog-malformed',
    'catalog-truncated',
    'catalog-oversized',
    'catalog-empty',
  ])('rejects a %s catalog before running models', async (mode) => {
    const smoke = await runFakeSmoke(mode, {
      ANTHROPIC_LIVE_TIMEOUT_MS: '100',
    })
    try {
      expect(await smoke.child.exited).not.toBe(0)
      await expect(access(smoke.modelMarker)).rejects.toThrow()
      expect(
        (await readdir(smoke.directory)).filter((entry) =>
          entry.startsWith('.anthropic-live-smoke-'),
        ),
      ).toEqual([])
    } finally {
      await rm(smoke.directory, { recursive: true, force: true })
    }
  })

  test('interrupting a huge inter-model delay exits and removes the sandbox', async () => {
    const smoke = await runFakeSmoke('valid', {
      FAKE_DELAY: '1',
      ANTHROPIC_LIVE_DELAY_MS: '600000',
    })
    try {
      await waitForFile(smoke.runMarker)
      await waitForFile(smoke.cleanupMarker)
      await Bun.sleep(100)
      const started = performance.now()
      smoke.child.kill('SIGINT')
      expect(await smoke.child.exited).not.toBe(0)
      expect(performance.now() - started).toBeLessThan(3_000)
      const serverPID = Number(await readFile(smoke.serverMarker, 'utf8'))
      expect(
        Bun.spawnSync(['kill', '-0', String(serverPID)]).exitCode,
      ).not.toBe(0)
      expect(
        (await readdir(smoke.directory)).filter((entry) =>
          entry.startsWith('.anthropic-live-smoke-'),
        ),
      ).toEqual([])
    } finally {
      await rm(smoke.directory, { recursive: true, force: true })
    }
  }, 8_000)

  test('kills a private-server descendant that retains inherited pipes', async () => {
    const smoke = await runFakeSmoke('inactive', {
      FORK_SERVER_HELPER: '1',
    })
    try {
      const exitCode = await Promise.race([
        smoke.child.exited,
        Bun.sleep(5_000).then(() => {
          smoke.child.kill('SIGKILL')
          throw new Error('Smoke process hung on private-server descendant')
        }),
      ])
      expect(exitCode).not.toBe(0)
      const helperPID = Number(await readFile(smoke.helperMarker, 'utf8'))
      expect(
        Bun.spawnSync(['kill', '-0', String(helperPID)]).exitCode,
      ).not.toBe(0)
    } finally {
      await rm(smoke.directory, { recursive: true, force: true })
    }
  }, 8_000)

  test('does not run models from a truncated catalog response', async () => {
    const smoke = await runFakeSmoke('catalog-truncated', {})
    try {
      expect(await smoke.child.exited).not.toBe(0)
      await expect(access(smoke.runMarker)).rejects.toThrow()
      expect(
        (await readdir(smoke.directory)).filter((entry) =>
          entry.startsWith('.anthropic-live-smoke-'),
        ),
      ).toEqual([])
    } finally {
      await rm(smoke.directory, { recursive: true, force: true })
    }
  }, 8_000)

  test('cleans up the exact failed run title and only matching sessions', async () => {
    const smoke = await runFakeSmoke('valid', { FAKE_RUN_FAILED: '1' })
    try {
      expect(await smoke.child.exited).not.toBe(0)
      await waitForFile(smoke.cleanupMarker)
      await waitForFile(smoke.deletedMarker)

      const title = await readFile(smoke.titleMarker, 'utf8')
      expect(title).toMatch(/^anthropic-live-smoke:[0-9a-f-]+:1$/)
      expect(await readFile(smoke.cleanupTitleMarker, 'utf8')).toBe(title)
      expect(await readFile(smoke.deletedMarker, 'utf8')).toBe('ses_matching\n')
      expect(
        (await readdir(smoke.directory)).filter((entry) =>
          entry.startsWith('.anthropic-live-smoke-'),
        ),
      ).toEqual([])

      const report = JSON.parse(await readFile(smoke.reportMarker, 'utf8')) as {
        modelCount: number
        results: Array<{ model: string; status: string; latencyMs: number }>
      }
      expect(report.modelCount).toBe(1)
      expect(report.results).toEqual([
        {
          model: 'anthropic/fake-model',
          status: 'failed',
          latencyMs: expect.any(Number),
        },
      ])
    } finally {
      await rm(smoke.directory, { recursive: true, force: true })
    }
  }, 8_000)
})

describe('live model command bounds', () => {
  test('fails closed on malformed UTF-8 command output', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.command-utf8-test-'))
    try {
      const script = await writeCommandScript(
        directory,
        'await Bun.write(Bun.stdout, Uint8Array.from([0xc3, 0x28]))',
      )
      const command = await runCommand(['bun', script], directory, 10_000)
      expect(command.exitCode).toBe(0)
      expect(command.stdout).toBe('')
      expect(command.stdoutTruncated).toBe(true)
      expect(classifySmokeResult(command)).toBe('failed')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('terminates an output-flooding child at one MiB and reports truncation', async () => {
    const directory = await mkdtemp(
      join(process.cwd(), '.command-output-test-'),
    )
    try {
      const script = await writeCommandScript(
        directory,
        `process.stdout.write('x'.repeat(1024 * 1024 + 1))
         setInterval(() => {}, 1000)`,
      )
      const command = await runCommand(['bun', script], directory, 10_000)
      expect(command.stdoutTruncated).toBe(true)
      expect(new TextEncoder().encode(command.stdout).byteLength).toBe(
        1024 * 1024,
      )
      expect(command.exitCode).not.toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 5_000)

  test('escalates a SIGTERM-ignoring child to SIGKILL promptly', async () => {
    const directory = await mkdtemp(
      join(process.cwd(), '.command-signal-test-'),
    )
    try {
      const script = await writeCommandScript(
        directory,
        `process.on('SIGTERM', () => {})
         setInterval(() => {}, 1000)`,
      )
      const started = performance.now()
      const command = await runCommand(['bun', script], directory, 25)
      expect(command.timedOut).toBe(true)
      expect(command.exitCode).not.toBe(0)
      expect(performance.now() - started).toBeLessThan(3_000)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 5_000)
})
