import { chmod, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SENTINEL = 'MODEL_SMOKE_OK'
const PLUGIN_ID = 'ink1.anthropic-auth'
const INTEGRATION_ID = 'anthropic'
const OAUTH_METHOD_ID = 'claude-max'
const SESSION_TITLE_PREFIX = 'anthropic-live-smoke'
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024
const MAX_LIVE_MODELS = 256
export const MAX_MODEL_ID_BYTES = 256
export const MAX_PREFLIGHT_RESULT_BYTES = 16 * 1024
const MAX_UNSAFE_DEBUG_BYTES_PER_MODEL = 16 * 1024
const MAX_CLEANUP_PAGES = 10
const MAX_CLEANUP_SESSIONS = 256
const INTERRUPTED_CLEANUP_TIMEOUT_MS = 5_000
type ChildProcess = {
  pid: number
  exited: Promise<number>
  kill(signal?: number | NodeJS.Signals): void
}
const activeChildren = new Map<ChildProcess, () => void>()
const interruptWaiters = new Set<() => void>()
let interruptSignal: NodeJS.Signals | undefined

export type SmokeStatus =
  | 'passed'
  | 'unsupported'
  | 'authentication_failed'
  | 'subscription_blocked'
  | 'usage_credits_required'
  | 'rate_limited'
  | 'server_error'
  | 'timed_out'
  | 'unexpected_output'
  | 'failed'

export type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export type UnsafeDebugOutput = {
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export type SmokeResult = {
  model: string
  status: SmokeStatus
  latencyMs: number
  debug?: UnsafeDebugOutput
}

export type PreflightResult = {
  pluginID: string | null
  pluginActive: boolean
  oauthMethodID: string | null
  oauthMethodRegistered: boolean
  activeCredentialType: string | null
  activeMethodID: string | null
}

export type CommandRunner = (
  command: string[],
  cwd: string,
  timeoutMs: number,
  env?: Record<string, string | undefined>,
) => Promise<CommandResult>

function isIncompleteCommand(result: CommandResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.stdoutTruncated ||
    result.stderrTruncated
  )
}

type PrivateServer = {
  url: string
  password: string
  stop(): Promise<void>
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {}
  }
  try {
    child.kill(signal)
  } catch {}
}

function childTerminator(child: ChildProcess): {
  clear(): void
  terminate(): void
} {
  let forceKill: ReturnType<typeof setTimeout> | undefined
  return {
    clear() {
      if (forceKill) clearTimeout(forceKill)
    },
    terminate() {
      signalChild(child, 'SIGTERM')
      if (forceKill) return
      forceKill = setTimeout(() => signalChild(child, 'SIGKILL'), 1_000)
      forceKill.unref?.()
    },
  }
}

export function isBlockingSmokeStatus(status: SmokeStatus): boolean {
  return status !== 'passed' && status !== 'usage_credits_required'
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires the ESC control byte.
const ansiPattern = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

export function parseAnthropicModels(output: string): string[] {
  const models = [
    ...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^anthropic\/[^\s]+$/.test(line)),
    ),
  ].sort()
  if (models.length > MAX_LIVE_MODELS) {
    throw new Error(
      `OpenCode returned ${models.length} Anthropic models; maximum is ${MAX_LIVE_MODELS}`,
    )
  }
  const encoder = new TextEncoder()
  for (const model of models) {
    if (encoder.encode(model).byteLength > MAX_MODEL_ID_BYTES) {
      throw new Error(
        `OpenCode returned an Anthropic model ID above the ${MAX_MODEL_ID_BYTES} byte limit`,
      )
    }
  }
  return models
}

export function classifySmokeResult(result: CommandResult): SmokeStatus {
  if (result.timedOut) return 'timed_out'
  if (result.stdoutTruncated || result.stderrTruncated) return 'failed'

  const output = `${result.stdout}\n${result.stderr}`
    .replace(ansiPattern, '')
    .toLowerCase()

  if (
    output.includes('invalid model') ||
    output.includes('model not found') ||
    output.includes('unknown model') ||
    output.includes('unsupported model') ||
    output.includes('not_found_error')
  ) {
    return 'unsupported'
  }
  if (
    output.includes('usage credits are required') ||
    output.includes('requires usage credits')
  ) {
    return 'usage_credits_required'
  }
  if (
    output.includes("you're out of extra usage") ||
    output.includes('usage limit') ||
    output.includes('subscription limit')
  ) {
    return 'subscription_blocked'
  }
  if (output.includes('rate limit') || /\b429\b/.test(output)) {
    return 'rate_limited'
  }
  if (
    output.includes('unauthorized') ||
    output.includes('invalid oauth') ||
    output.includes('authentication failed') ||
    /\b(401|403)\b/.test(output)
  ) {
    return 'authentication_failed'
  }
  if (
    output.includes('overloaded') ||
    output.includes('internal server error') ||
    /\b(500|502|503|504|529)\b/.test(output)
  ) {
    return 'server_error'
  }
  if (result.exitCode === 0 && output.includes(SENTINEL.toLowerCase())) {
    return 'passed'
  }
  if (result.exitCode === 0) return 'unexpected_output'
  return 'failed'
}

export function buildSmokeResult(
  model: string,
  status: SmokeStatus,
  latencyMs: number,
  command: CommandResult,
  unsafeDebug: boolean,
): SmokeResult {
  const result: SmokeResult = { model, status, latencyMs }
  if (unsafeDebug) {
    const stdout = retainUtf8(command.stdout, MAX_UNSAFE_DEBUG_BYTES_PER_MODEL)
    const stderr = retainUtf8(
      command.stderr,
      MAX_UNSAFE_DEBUG_BYTES_PER_MODEL - stdout.bytes,
    )
    result.debug = {
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: command.stdoutTruncated || stdout.truncated,
      stderrTruncated: command.stderrTruncated || stderr.truncated,
    }
  }
  return result
}

function retainUtf8(
  value: string,
  maxBytes: number,
): { text: string; bytes: number; truncated: boolean } {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength <= maxBytes) {
    return { text: value, bytes: encoded.byteLength, truncated: false }
  }
  const text = new TextDecoder().decode(encoded.subarray(0, maxBytes))
  return {
    text,
    bytes: new TextEncoder().encode(text).byteLength,
    truncated: true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parsePreflightResult(value: unknown): PreflightResult {
  if (!isRecord(value)) throw new Error('Invalid preflight result')

  const nullableString = (key: keyof PreflightResult): string | null => {
    const field = value[key]
    if (field === null || typeof field === 'string') return field
    throw new Error('Invalid preflight result')
  }
  const boolean = (key: keyof PreflightResult): boolean => {
    const field = value[key]
    if (typeof field === 'boolean') return field
    throw new Error('Invalid preflight result')
  }

  return {
    pluginID: nullableString('pluginID'),
    pluginActive: boolean('pluginActive'),
    oauthMethodID: nullableString('oauthMethodID'),
    oauthMethodRegistered: boolean('oauthMethodRegistered'),
    activeCredentialType: nullableString('activeCredentialType'),
    activeMethodID: nullableString('activeMethodID'),
  }
}

export function hasActivePlugin(output: string, expectedID: string): boolean {
  const value: unknown = JSON.parse(output)
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('Invalid plugin list response')
  }

  return value.data.some((item) => {
    if (!isRecord(item) || item.id !== expectedID) return false
    return isRecord(item.state) && item.state.status === 'active'
  })
}

export function hasOAuthMethod(
  output: string,
  integrationID: string,
  methodID: string,
): boolean {
  const value: unknown = JSON.parse(output)
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new Error('Invalid integration response')
  }
  if (value.data.id !== integrationID || !Array.isArray(value.data.methods)) {
    throw new Error('Invalid integration response')
  }
  return value.data.methods.some(
    (method) =>
      isRecord(method) && method.type === 'oauth' && method.id === methodID,
  )
}

export function parsePrivateServerURL(line: string): string {
  const prefix = 'server listening on '
  if (!line.startsWith(prefix)) throw new Error('Invalid private server output')

  const url = new URL(line.slice(prefix.length).trim())
  const port = Number(url.port)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.pathname !== '/'
  ) {
    throw new Error('Private OpenCode server is not bound to loopback')
  }
  return url.origin
}

export function assertSafePreflight(result: PreflightResult): void {
  if (!result.pluginActive || result.pluginID !== PLUGIN_ID) {
    throw new Error(`Required plugin ${PLUGIN_ID} is not active`)
  }
  if (
    !result.oauthMethodRegistered ||
    result.oauthMethodID !== OAUTH_METHOD_ID
  ) {
    throw new Error(
      `Required Anthropic OAuth method ${OAUTH_METHOD_ID} is not registered`,
    )
  }
  if (
    result.activeCredentialType !== 'oauth' ||
    result.activeMethodID !== OAUTH_METHOD_ID
  ) {
    throw new Error(
      `Active Anthropic connection is not using ${OAUTH_METHOD_ID} OAuth`,
    )
  }
}

export function parseExactSessionIDs(
  output: string,
  expectedTitle: string,
): string[] {
  return parseSessionPage(output, expectedTitle).ids
}

export function parseSessionPage(
  output: string,
  expectedTitle: string,
): { ids: string[]; next: string | null } {
  const value: unknown = JSON.parse(output)
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('Invalid session list response')
  }

  const ids = value.data.flatMap((item): string[] => {
    if (!isRecord(item)) return []
    if (item.title !== expectedTitle) return []
    return typeof item.id === 'string' && /^ses[\w-]+$/.test(item.id)
      ? [item.id]
      : []
  })
  const next = isRecord(value.cursor) ? value.cursor.next : null
  if (
    next !== null &&
    next !== undefined &&
    (typeof next !== 'string' || next.length === 0 || next.length > 4_096)
  ) {
    throw new Error('Invalid session list response')
  }
  return { ids, next: typeof next === 'string' ? next : null }
}

export async function cleanupSmokeSessions(
  runner: CommandRunner,
  binary: string,
  cwd: string,
  timeoutMs: number,
  title: string,
  env?: Record<string, string | undefined>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const remainingTimeout = () => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`Timed out cleaning up smoke-test session ${title}`)
    }
    return remaining
  }
  const sessionIDs = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | null = null
  for (let pageNumber = 0; pageNumber < MAX_CLEANUP_PAGES; pageNumber += 1) {
    const query = new URLSearchParams({ search: title, limit: '100' })
    if (cursor) query.set('cursor', cursor)
    const listed = await runner(
      [
        binary,
        'api',
        '--standalone',
        'get',
        `/api/session?${query.toString()}`,
      ],
      cwd,
      remainingTimeout(),
      env,
    )
    if (isIncompleteCommand(listed)) {
      throw new Error(`Unable to clean up smoke-test session ${title}`)
    }

    const page = parseSessionPage(listed.stdout, title)
    for (const sessionID of page.ids) sessionIDs.add(sessionID)
    if (sessionIDs.size > MAX_CLEANUP_SESSIONS) {
      throw new Error(`Too many smoke-test sessions match ${title}`)
    }
    if (!page.next) break
    if (cursors.has(page.next)) {
      throw new Error(`Repeated session cleanup cursor for ${title}`)
    }
    cursors.add(page.next)
    cursor = page.next
    if (pageNumber === MAX_CLEANUP_PAGES - 1) {
      throw new Error(`Too many session cleanup pages for ${title}`)
    }
  }

  for (const sessionID of sessionIDs) {
    const removed = await runner(
      [binary, 'api', '--standalone', 'delete', `/api/session/${sessionID}`],
      cwd,
      remainingTimeout(),
      env,
    )
    if (isIncompleteCommand(removed)) {
      throw new Error(`Unable to delete smoke-test session ${sessionID}`)
    }
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onLimit: () => void,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let retained = 0
  let total = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    const remaining = maxBytes - retained
    if (remaining > 0) {
      const chunk = value.subarray(0, remaining).slice()
      chunks.push(chunk)
      retained += chunk.byteLength
    }
    if (total > maxBytes) {
      onLimit()
      await reader.cancel('command output exceeded the configured limit')
      break
    }
  }

  const bytes = new Uint8Array(retained)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      truncated: total > maxBytes,
    }
  } catch {
    return { text: '', truncated: true }
  }
}

export async function readBoundedUtf8File(
  path: string,
  maxBytes = MAX_PREFLIGHT_RESULT_BYTES,
): Promise<string> {
  const file = await open(path, 'r')
  try {
    const bytes = new Uint8Array(maxBytes + 1)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      )
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maxBytes) {
      throw new Error(`File exceeds the ${maxBytes} byte limit`)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, offset),
    )
  } finally {
    await file.close()
  }
}

export const runCommand: CommandRunner = async (
  command,
  cwd,
  timeoutMs,
  env,
) => {
  const child = Bun.spawn(command, {
    cwd,
    detached: true,
    env: { ...process.env, ...env, NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const terminator = childTerminator(child)
  activeChildren.set(child, terminator.terminate)

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    terminator.terminate()
  }, timeoutMs)
  timeout.unref?.()

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(child.stdout, MAX_COMMAND_OUTPUT_BYTES, terminator.terminate),
      readBounded(child.stderr, MAX_COMMAND_OUTPUT_BYTES, terminator.terminate),
      child.exited,
    ])

    return {
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      timedOut,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    }
  } finally {
    activeChildren.delete(child)
    clearTimeout(timeout)
    terminator.clear()
  }
}

function installInterruptHandlers(): () => void {
  interruptSignal = undefined
  const handle = (signal: NodeJS.Signals) => {
    if (interruptSignal) return
    interruptSignal = signal
    for (const terminate of activeChildren.values()) terminate()
    for (const wake of interruptWaiters) wake()
  }
  process.on('SIGINT', handle)
  process.on('SIGTERM', handle)
  return () => {
    process.off('SIGINT', handle)
    process.off('SIGTERM', handle)
  }
}

function throwIfInterrupted(): void {
  if (interruptSignal) throw new Error(`Interrupted by ${interruptSignal}`)
}

async function interruptibleSleep(ms: number): Promise<void> {
  throwIfInterrupted()
  let wake!: () => void
  let timer: ReturnType<typeof setTimeout> | undefined
  const interrupted = new Promise<void>((resolve) => {
    wake = resolve
    interruptWaiters.add(wake)
  })
  const delayed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  try {
    await Promise.race([delayed, interrupted])
  } finally {
    if (timer) clearTimeout(timer)
    interruptWaiters.delete(wake)
  }
  throwIfInterrupted()
}

export function buildProbePluginSource(resultPath: string): string {
  return `import { writeFile } from 'node:fs/promises'
import { Plugin } from '@opencode-ai/plugin'

const RESULT_PATH = ${JSON.stringify(resultPath)}
const INTEGRATION_ID = ${JSON.stringify(INTEGRATION_ID)}

export default Plugin.define({
  id: 'anthropic-live-smoke-preflight',
  setup: async (ctx) => {
    const connection = await ctx.integration.connection.active(INTEGRATION_ID)
    const credential = connection
      ? await ctx.integration.connection.resolve(connection)
      : undefined
    const result = {
      pluginID: null,
      pluginActive: false,
      oauthMethodID: null,
      oauthMethodRegistered: false,
      activeCredentialType: credential?.type ?? null,
      activeMethodID:
        credential?.type === 'oauth' ? String(credential.methodID) : null,
    }
    await writeFile(RESULT_PATH, JSON.stringify(result), {
      encoding: 'utf8',
      mode: 0o600,
    })
  },
})
`
}

async function createSmokeSandbox(cwd: string): Promise<{
  directory: string
  preflightPath: string
  pluginPath: string
}> {
  const directory = await mkdtemp(join(cwd, '.anthropic-live-smoke-'))
  try {
    const pluginDirectory = join(directory, 'preflight-plugin')
    const preflightPath = join(directory, 'preflight.json')
    const pluginPath = join(pluginDirectory, 'index.ts')
    await mkdir(pluginDirectory, { recursive: true })
    await Bun.write(pluginPath, buildProbePluginSource(preflightPath))
    await chmod(pluginPath, 0o600)
    return { directory, preflightPath, pluginPath }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function startPrivateServer(
  binary: string,
  cwd: string,
  timeoutMs: number,
  configOverlay: string,
): Promise<PrivateServer> {
  const password = `${crypto.randomUUID()}${crypto.randomUUID()}`
  const child = Bun.spawn(
    [binary, 'serve', '--hostname', '127.0.0.1', '--port', '0'],
    {
      cwd,
      detached: true,
      env: {
        ...process.env,
        NO_COLOR: '1',
        OPENCODE_CONFIG_CONTENT: configOverlay,
        OPENCODE_SERVER_PASSWORD: password,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const terminator = childTerminator(child)
  activeChildren.set(child, terminator.terminate)

  let resolveURL!: (url: string) => void
  let rejectURL!: (error: Error) => void
  const startupURL = new Promise<string>((resolve, reject) => {
    resolveURL = resolve
    rejectURL = reject
  })
  let startupSettled = false
  const stdoutDrain = (async () => {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let pending = ''
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_COMMAND_OUTPUT_BYTES) {
        terminator.terminate()
        await reader.cancel(
          'private server output exceeded the configured limit',
        )
        break
      }
      if (startupSettled) continue

      pending += decoder.decode(value, { stream: true })
      if (new TextEncoder().encode(pending).byteLength > 4_096) {
        throw new Error('Private OpenCode server startup output is too large')
      }
      const newline = pending.indexOf('\n')
      if (newline === -1) continue

      const url = parsePrivateServerURL(pending.slice(0, newline).trim())
      startupSettled = true
      resolveURL(url)
      pending = ''
    }
    if (!startupSettled) pending += decoder.decode()
    if (!startupSettled) {
      throw new Error('Private OpenCode server exited before reporting its URL')
    }
  })().catch((error) => {
    if (!startupSettled) {
      startupSettled = true
      rejectURL(error instanceof Error ? error : new Error(String(error)))
    }
  })
  const stderrDrain = readBounded(
    child.stderr,
    MAX_COMMAND_OUTPUT_BYTES,
    terminator.terminate,
  )

  const stop = async () => {
    terminator.terminate()
    const settled = Promise.all([child.exited, stdoutDrain, stderrDrain])
    const completelyStopped = await Promise.race([
      settled.then(() => true),
      Bun.sleep(1_100).then(() => false),
    ])
    if (!completelyStopped) {
      signalChild(child, 'SIGKILL')
    }
    try {
      await settled
    } finally {
      activeChildren.delete(child)
      terminator.clear()
    }
  }

  const startupTimeout = setTimeout(() => {
    if (startupSettled) return
    startupSettled = true
    rejectURL(new Error('Timed out starting private OpenCode server'))
  }, timeoutMs)
  startupTimeout.unref?.()

  try {
    const url = await startupURL
    return { url, password, stop }
  } catch (error) {
    await stop()
    throw error
  } finally {
    clearTimeout(startupTimeout)
  }
}

export async function writePrivateReport(
  path: string,
  content: string,
): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${crypto.randomUUID()}.tmp`,
  )
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(content, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function runPreflight(
  binary: string,
  sandbox: { directory: string; preflightPath: string; pluginPath: string },
  timeoutMs: number,
): Promise<PreflightResult> {
  const configuredPlugin = process.env.ANTHROPIC_LIVE_PLUGIN?.trim()
  const configOverlay = JSON.stringify({
    plugin: [
      ...(configuredPlugin ? [configuredPlugin] : []),
      pathToFileURL(dirname(sandbox.pluginPath)).href,
    ],
  })
  const server = await startPrivateServer(
    binary,
    sandbox.directory,
    timeoutMs,
    configOverlay,
  )
  try {
    const barrier = await runCommand(
      [binary, 'auth', 'list', '--server', server.url, '--format', 'json'],
      sandbox.directory,
      timeoutMs,
      { OPENCODE_SERVER_PASSWORD: server.password },
    )
    if (isIncompleteCommand(barrier)) {
      throw new Error('Unable to initialize isolated OpenCode integrations')
    }

    const command = await runCommand(
      [binary, 'api', '--server', server.url, 'get', '/api/plugin'],
      sandbox.directory,
      timeoutMs,
      { OPENCODE_SERVER_PASSWORD: server.password },
    )
    if (isIncompleteCommand(command)) {
      throw new Error('Unable to inspect isolated OpenCode plugins')
    }

    const integration = await runCommand(
      [
        binary,
        'api',
        '--server',
        server.url,
        'get',
        `/api/integration/${INTEGRATION_ID}`,
      ],
      sandbox.directory,
      timeoutMs,
      { OPENCODE_SERVER_PASSWORD: server.password },
    )
    if (isIncompleteCommand(integration)) {
      throw new Error('Unable to inspect isolated OpenCode integrations')
    }

    let value: unknown
    try {
      value = JSON.parse(await readBoundedUtf8File(sandbox.preflightPath))
    } catch {
      throw new Error('OpenCode preflight plugin did not produce a result')
    }
    const pluginActive = hasActivePlugin(command.stdout, PLUGIN_ID)
    const oauthMethodRegistered = hasOAuthMethod(
      integration.stdout,
      INTEGRATION_ID,
      OAUTH_METHOD_ID,
    )
    const result = {
      ...parsePreflightResult(value),
      pluginID: pluginActive ? PLUGIN_ID : null,
      pluginActive,
      oauthMethodID: oauthMethodRegistered ? OAUTH_METHOD_ID : null,
      oauthMethodRegistered,
    }
    assertSafePreflight(result)
    return result
  } finally {
    await server.stop()
  }
}

export function livePluginEnvironment():
  | Record<string, string | undefined>
  | undefined {
  const plugin = process.env.ANTHROPIC_LIVE_PLUGIN?.trim()
  if (!plugin) return undefined
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [plugin] }),
  }
}

async function main() {
  if (process.env.ANTHROPIC_LIVE_SMOKE !== '1') {
    console.error(
      'Live model tests are disabled. Set ANTHROPIC_LIVE_SMOKE=1 to run them.',
    )
    process.exitCode = 2
    return
  }

  const binary = process.env.OPENCODE_BIN?.trim() || 'opencode2'
  const cwd = process.env.ANTHROPIC_LIVE_CWD?.trim() || process.cwd()
  const timeoutMs = positiveInteger(
    process.env.ANTHROPIC_LIVE_TIMEOUT_MS,
    60_000,
  )
  const delayMs = positiveInteger(process.env.ANTHROPIC_LIVE_DELAY_MS, 1_000)
  const unsafeDebug = process.env.ANTHROPIC_LIVE_UNSAFE_DEBUG === '1'
  const pluginEnvironment = livePluginEnvironment()
  if (unsafeDebug) {
    console.warn(
      'UNSAFE DEBUG ENABLED: raw CLI/provider output may be persisted in the report.',
    )
  }

  const removeInterruptHandlers = installInterruptHandlers()
  let sandbox: Awaited<ReturnType<typeof createSmokeSandbox>> | undefined
  try {
    sandbox = await createSmokeSandbox(cwd)
    throwIfInterrupted()
    const preflight = await runPreflight(binary, sandbox, timeoutMs)
    throwIfInterrupted()
    console.log(
      `Preflight passed: ${preflight.pluginID}, Anthropic OAuth ${preflight.activeMethodID}.`,
    )
    if (process.env.ANTHROPIC_LIVE_PREFLIGHT_ONLY === '1') return

    const discovery = await runCommand(
      [binary, 'models', '--standalone'],
      sandbox.directory,
      timeoutMs,
      pluginEnvironment,
    )
    throwIfInterrupted()
    if (isIncompleteCommand(discovery)) {
      throw new Error('Unable to discover OpenCode models')
    }

    const models = parseAnthropicModels(discovery.stdout)
    if (models.length === 0) {
      throw new Error('OpenCode returned no anthropic/* models')
    }

    console.log(
      `Discovered ${models.length} Anthropic models; running sequentially.`,
    )
    const results: SmokeResult[] = []
    const runID = crypto.randomUUID()

    for (const [index, model] of models.entries()) {
      throwIfInterrupted()
      const title = `${SESSION_TITLE_PREFIX}:${runID}:${index + 1}`
      const started = performance.now()
      let command: CommandResult | undefined
      try {
        command = await runCommand(
          [
            binary,
            'run',
            '--standalone',
            '--format',
            'json',
            '--title',
            title,
            '--model',
            model,
            `Reply with exactly: ${SENTINEL}`,
          ],
          sandbox.directory,
          timeoutMs,
          pluginEnvironment,
        )
      } finally {
        await cleanupSmokeSessions(
          runCommand,
          binary,
          sandbox.directory,
          interruptSignal
            ? Math.min(timeoutMs, INTERRUPTED_CLEANUP_TIMEOUT_MS)
            : timeoutMs,
          title,
          pluginEnvironment,
        )
      }
      throwIfInterrupted()
      if (!command)
        throw new Error(`Model command failed to start for ${model}`)

      const status = classifySmokeResult(command)
      const latencyMs = Math.round(performance.now() - started)
      results.push(
        buildSmokeResult(model, status, latencyMs, command, unsafeDebug),
      )
      console.log(
        `[${String(index + 1).padStart(String(models.length).length)}/${models.length}] ${model} — ${status} (${latencyMs} ms)`,
      )

      if (index < models.length - 1) await interruptibleSleep(delayMs)
    }

    const report = {
      generatedAt: new Date().toISOString(),
      preflight: {
        pluginID: preflight.pluginID,
        oauthMethodID: preflight.activeMethodID,
      },
      modelCount: models.length,
      results,
    }
    const reportPath = process.env.ANTHROPIC_LIVE_REPORT?.trim()
    if (reportPath) {
      await writePrivateReport(
        reportPath,
        `${JSON.stringify(report, null, 2)}\n`,
      )
      console.log(`Structured report written to ${reportPath}`)
    }

    const counts = Object.groupBy(results, (result) => result.status)
    console.log('\nSummary:')
    for (const status of [...new Set(results.map((result) => result.status))]) {
      console.log(`  ${status}: ${counts[status]?.length ?? 0}`)
    }

    if (results.some((result) => isBlockingSmokeStatus(result.status))) {
      process.exitCode = 1
    }
  } finally {
    removeInterruptHandlers()
    if (sandbox) {
      await rm(sandbox.directory, { recursive: true, force: true })
    }
  }
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Live model smoke test failed',
    )
    process.exitCode = 1
  })
}
