import { describe, expect, test } from 'bun:test'
import {
  createStrippedStream,
  MAX_SSE_LINE_BYTES,
  prefixToolNames,
  stripToolPrefix,
} from '../transform'

const encoder = new TextEncoder()

function streamOf(
  chunks: Array<string | Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === 'string' ? encoder.encode(chunk) : chunk,
        )
      }
      controller.close()
    },
  })
}

function sseResponse(
  chunks: Array<string | Uint8Array>,
  headers: Record<string, string> = {},
): Response {
  return new Response(streamOf(chunks), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  })
}

async function readText(response: Response): Promise<string> {
  return await new Response(response.body).text()
}

const TOOL_EVENT =
  'event: content_block_start\n' +
  'data: {"type":"content_block_start","index":0,' +
  '"content_block":{"type":"tool_use","id":"toolu_1","name":"mcp_Read","input":{}}}\n\n'

// stripToolPrefix normalises to `"name": "x"` and lower-cases the first letter.
const EXPECTED = TOOL_EVENT.replace('"name":"mcp_Read"', '"name": "read"')

describe('createStrippedStream - chunk boundaries', () => {
  test('strips the prefix at every possible two-chunk split point', async () => {
    for (let index = 1; index < TOOL_EVENT.length; index++) {
      const chunks = [TOOL_EVENT.slice(0, index), TOOL_EVENT.slice(index)]
      expect(await readText(createStrippedStream(sseResponse(chunks)))).toBe(
        EXPECTED,
      )
    }
  })

  test('strips a prefix delivered one byte per chunk', async () => {
    const bytes = Array.from(
      encoder.encode(TOOL_EVENT),
      (byte) => new Uint8Array([byte]),
    )
    expect(await readText(createStrippedStream(sseResponse(bytes)))).toBe(
      EXPECTED,
    )
  })

  test('tolerates interleaved empty chunks', async () => {
    const chunks = ['', TOOL_EVENT.slice(0, 20), '', TOOL_EVENT.slice(20), '']
    expect(await readText(createStrippedStream(sseResponse(chunks)))).toBe(
      EXPECTED,
    )
  })

  test('preserves a 4-byte emoji split across chunks', async () => {
    const payload =
      'data: {"type":"content_block_delta","delta":{"text":"\u{1F680} ok"}}\n\n'
    const bytes = encoder.encode(payload)
    const cut = bytes.indexOf(0xf0) + 2
    const output = await readText(
      createStrippedStream(
        sseResponse([bytes.slice(0, cut), bytes.slice(cut)]),
      ),
    )
    expect(output).toBe(payload)
  })

  test('flushes a dangling partial prefix at end of stream', async () => {
    const partial = 'data: {"name":"mcp'
    expect(await readText(createStrippedStream(sseResponse([partial])))).toBe(
      partial,
    )
  })
})

describe('createStrippedStream - correctness guards', () => {
  test('handles CR-only SSE line endings', async () => {
    const payload = 'data: {"name":"mcp_Read"}\r\r'
    const expected = 'data: {"name": "read"}\r\r'
    const chunks = payload.split('')

    expect(await readText(createStrippedStream(sseResponse(chunks)))).toBe(
      expected,
    )
  })

  test('preserves CRLF endings split across chunks', async () => {
    const expected = 'data: {"name": "read"}\r\n\r\n'
    const chunks = ['data: {"name":"mcp_', 'Read"}\r', '\n\r', '\n']

    expect(await readText(createStrippedStream(sseResponse(chunks)))).toBe(
      expected,
    )
  })

  test('rejects a newline-free SSE line above the buffer limit', async () => {
    const oversized = `data: ${'x'.repeat(MAX_SSE_LINE_BYTES)}`
    const response = createStrippedStream(sseResponse([oversized]))

    await expect(readText(response)).rejects.toThrow(
      `SSE line exceeds ${MAX_SSE_LINE_BYTES} byte limit`,
    )
  })

  test('rejects an oversized line ending in the same chunk', async () => {
    const oversized = `${'x'.repeat(MAX_SSE_LINE_BYTES + 1)}\n`
    const response = createStrippedStream(sseResponse([oversized]))

    await expect(readText(response)).rejects.toThrow(
      `SSE line exceeds ${MAX_SSE_LINE_BYTES} byte limit`,
    )
  })

  test('accepts a large chunk containing many bounded lines', async () => {
    const line = 'data: x\n'
    const payload = line.repeat(Math.ceil(MAX_SSE_LINE_BYTES / line.length))

    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      payload,
    )
  })

  test('accepts a line exactly at the buffer limit', async () => {
    const payload = 'x'.repeat(MAX_SSE_LINE_BYTES)

    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      payload,
    )
  })

  test('enforces the byte limit for multi-byte UTF-8 input', async () => {
    const payload = '🚀'.repeat(Math.floor(MAX_SSE_LINE_BYTES / 4) + 1)
    const response = createStrippedStream(sseResponse([payload]))

    await expect(readText(response)).rejects.toThrow(
      `SSE line exceeds ${MAX_SSE_LINE_BYTES} byte limit`,
    )
  })

  test('is a no-op for a stream with no prefixed names', async () => {
    const payload = 'data: {"type":"message_stop"}\n\ndata: [DONE]\n\n'
    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      payload,
    )
  })

  test('strips several tool names in a single chunk', async () => {
    const payload = ['mcp_Read', 'mcp_Write', 'mcp_Shell']
      .map((name) => `data: {"name":"${name}"}\n\n`)
      .join('')
    const expected = ['read', 'write', 'shell']
      .map((name) => `data: {"name": "${name}"}\n\n`)
      .join('')
    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      expected,
    )
  })

  test('strips a very long name spanning many chunks', async () => {
    const payload = `data: {"name":"mcp_${'A'.repeat(300)}"}\n\n`
    const expected = `data: {"name": "a${'A'.repeat(299)}"}\n\n`
    const chunks = payload.match(/.{1,7}/gs) ?? []
    expect(await readText(createStrippedStream(sseResponse(chunks)))).toBe(
      expected,
    )
  })

  test('normalises whitespace variants of the name field', () => {
    expect(stripToolPrefix('{"name"  :  "mcp_Read"}')).toBe('{"name": "read"}')
  })

  test('keeps StructuredOutput unchanged apart from the prefix', () => {
    expect(stripToolPrefix('{"name":"mcp_StructuredOutput"}')).toBe(
      '{"name": "StructuredOutput"}',
    )
  })
})

describe('createStrippedStream - transport semantics', () => {
  test('preserves status, statusText and passthrough headers', () => {
    const response = createStrippedStream(
      new Response(streamOf([TOOL_EVENT]), {
        status: 207,
        statusText: 'Multi-Status',
        headers: {
          'content-type': 'text/event-stream',
          'x-request-id': 'req_1',
        },
      }),
    )
    expect(response.status).toBe(207)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('x-request-id')).toBe('req_1')
  })

  test('drops content-length because the body length changes', () => {
    const response = createStrippedStream(
      sseResponse([TOOL_EVENT], {
        'content-length': String(TOOL_EVENT.length),
      }),
    )
    expect(response.headers.get('content-length')).toBeNull()
  })

  test('propagates an upstream stream error instead of truncating silently', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"name":"mcp_Re'))
        controller.error(new Error('upstream boom'))
      },
    })
    const response = createStrippedStream(
      new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    await expect(readText(response)).rejects.toThrow('upstream boom')
  })
})

describe('prefix round-trip', () => {
  test('stripToolPrefix reverses prefixToolNames for lowercase tool names', () => {
    const body = {
      tools: [{ name: 'read' }, { name: 'write' }],
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'shell', input: {} }],
        },
      ],
    }
    const prefixed = prefixToolNames(structuredClone(body))
    expect(prefixed).toContain('"name":"mcp_Read"')
    expect(JSON.parse(stripToolPrefix(prefixed))).toEqual(body)
  })

  test('does not restore the original case for PascalCase tool names', () => {
    const prefixed = prefixToolNames({ tools: [{ name: 'Read' }] })
    // documented asymmetry: Read -> mcp_Read -> read
    expect(JSON.parse(stripToolPrefix(prefixed)).tools[0].name).toBe('read')
  })
})

describe('createStrippedStream - cancellation', () => {
  test('forwards consumer cancellation to the upstream stream', async () => {
    let cancelled = false
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(TOOL_EVENT))
      },
      cancel() {
        cancelled = true
      },
    })
    const response = createStrippedStream(
      new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cancelled).toBe(true)
  })

  test('buffers a chunk without a newline until flush', async () => {
    const output = await readText(
      createStrippedStream(sseResponse(['data: {"name":"mcp_Read"}'])),
    )
    expect(output).toBe('data: {"name": "read"}')
  })
})
