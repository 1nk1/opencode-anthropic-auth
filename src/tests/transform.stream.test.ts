import { describe, expect, spyOn, test } from 'bun:test'
import {
  MAX_JSON_DEPTH,
  MAX_JSON_NUMBER_BYTES,
  MAX_JSON_STRING_BYTES,
} from '../json-response-stream'
import {
  createStrippedStream,
  MAX_JSON_TOOL_NAME_BYTES,
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

// Response transformation lower-cases the first letter of prefixed tool names.
const EXPECTED = TOOL_EVENT.replace('"name":"mcp_Read"', '"name":"read"')

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
    const payload =
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Read"}}\r\r'
    const expected =
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"read"}}\r\r'
    const chunks = payload.split('')

    expect(await readText(createStrippedStream(sseResponse(chunks)))).toBe(
      expected,
    )
  })

  test('preserves CRLF endings split across chunks', async () => {
    const expected =
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"read"}}\r\n\r\n'
    const chunks = [
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_',
      'Read"}}\r',
      '\n\r',
      '\n',
    ]

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

  test('does not attempt a whole-document parse for an SSE event batch', async () => {
    const payload =
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Read"}}\n\n'
    const parse = spyOn(JSON, 'parse')

    try {
      const output = await readText(
        createStrippedStream(sseResponse([payload])),
      )

      expect(output).toBe(payload.replace('"mcp_Read"', '"read"'))
      expect(parse.mock.calls.some(([input]) => input === payload)).toBe(false)
    } finally {
      parse.mockRestore()
    }
  })

  test('strips several tool names in a single chunk', async () => {
    const payload = ['mcp_Read', 'mcp_Write', 'mcp_Shell']
      .map(
        (name) =>
          `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${name}"}}\n\n`,
      )
      .join('')
    const expected = ['read', 'write', 'shell']
      .map(
        (name) =>
          `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${name}"}}\n\n`,
      )
      .join('')
    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      expected,
    )
  })

  test('strips a very long name spanning many chunks', async () => {
    const payload = `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_${'A'.repeat(300)}"}}\n\n`
    const expected = `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"a${'A'.repeat(299)}"}}\n\n`
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

  test('does not rewrite unrelated name fields in SSE JSON', async () => {
    const payload =
      'data: {"type":"message_delta","metadata":{"name":"mcp_Read"}}\n\n'

    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      payload,
    )
  })

  test('rewrites only tool_use.name when unrelated names share the prefix', async () => {
    const payload =
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Read","metadata":{"name":"mcp_Nested"}},"metadata":{"name":"mcp_Top"}}\n\n'
    const output = await readText(createStrippedStream(sseResponse([payload])))
    const value = JSON.parse(output.slice('data: '.length).trim())

    expect(value.content_block.name).toBe('read')
    expect(value.content_block.metadata.name).toBe('mcp_Nested')
    expect(value.metadata.name).toBe('mcp_Top')
  })

  test('does not rewrite a fake tool_use object inside tool input', async () => {
    const payload =
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Read","input":{"payload":{"type":"tool_use","name":"mcp_NotATool"}}}}\n\n'
    const expected = payload.replace('"name":"mcp_Read"', '"name":"read"')

    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      expected,
    )
  })

  test('preserves whitespace and JSON escapes outside the name token', async () => {
    const payload =
      'data: { "type" : "content_block_start", "content_block" : { "type" : "tool_use", "name" : "mcp_Read", "text" : "\\u0061", "input" : { "spaced" : true } } }\n\n'
    const expected = payload.replace('"mcp_Read"', '"read"')

    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      expected,
    )
  })

  test('rewrites only the effective value of a duplicate name key', async () => {
    const payload =
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Decoy","name":"mcp_Read","input":{}}}\n\n'
    const expected = payload.replace('"name":"mcp_Read"', '"name":"read"')

    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      expected,
    )
  })

  test('rewrites tool blocks only in a complete message content array', async () => {
    const payload =
      '\n  { "type" : "message", "content" : [{"type":"text","text":"mcp_Read"},{"type":"tool_use","name":"mcp_Read","input":{}}] }'
    const expected = payload.replace('"name":"mcp_Read"', '"name":"read"')

    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      expected,
    )
  })

  test('rejects response JSON above the traversal depth limit', async () => {
    let input: Record<string, unknown> = {}
    for (let depth = 0; depth < 258; depth++) input = { nested: input }
    const value = {
      type: 'content_block_start',
      content_block: { type: 'tool_use', name: 'mcp_Read', input },
    }
    const response = createStrippedStream(
      sseResponse([`data: ${JSON.stringify(value)}\n\n`]),
    )

    await expect(readText(response)).rejects.toThrow(
      'Anthropic response JSON exceeds traversal limits',
    )
  })

  test('rejects malformed UTF-8 instead of inserting replacement text', async () => {
    const malformed = Uint8Array.of(
      ...encoder.encode('data: {"type":"text","text":"'),
      0xc3,
      0x28,
      ...encoder.encode('"}\n\n'),
    )

    await expect(
      readText(createStrippedStream(sseResponse([malformed]))),
    ).rejects.toBeInstanceOf(TypeError)
  })
})

describe('createStrippedStream - transport semantics', () => {
  test('returns an oversized non-JSON response unchanged', async () => {
    const body = new Uint8Array(MAX_SSE_LINE_BYTES + 1).fill(0x78)
    const original = new Response(body, {
      status: 502,
      headers: { 'content-type': 'application/octet-stream' },
    })

    const result = createStrippedStream(original)

    expect(result).toBe(original)
    expect((await result.arrayBuffer()).byteLength).toBe(body.byteLength)
  })

  test('strips tool prefixes from a non-streaming JSON response', async () => {
    const payload =
      '{"type":"message","content":[{"type":"tool_use","name":"mcp_Read","input":{}}]}'
    const response = createStrippedStream(
      new Response(payload, {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    )

    expect(await readText(response)).toContain('"name":"read"')
    expect(response.headers.has('content-length')).toBe(false)
  })

  test('rejects malformed JSON', async () => {
    const body = new TextEncoder().encode('not-json')
    const response = createStrippedStream(
      new Response(streamOf([body]), {
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(response.arrayBuffer()).rejects.toThrow()
  })

  test('bounds buffered JSON between emitted tokens', async () => {
    const payload = `{"value":1 ${' '.repeat(MAX_JSON_STRING_BYTES + 4096)}`
    const response = createStrippedStream(
      new Response(streamOf([payload]), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(readText(response)).rejects.toThrow(
      'Anthropic response JSON exceeds bounded token buffer',
    )
  })

  test('rejects invalid UTF-8 JSON', async () => {
    const body = new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])
    const response = createStrippedStream(
      new Response(streamOf([body]), {
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(response.arrayBuffer()).rejects.toThrow()
  })

  test('rejects a UTF-8 BOM split across chunks', async () => {
    const payload = encoder.encode(
      '{"type":"message","content":[{"type":"tool_use","name":"mcp_Read"}]}',
    )
    const response = createStrippedStream(
      new Response(
        streamOf([
          Uint8Array.of(0xef),
          Uint8Array.of(0xbb),
          Uint8Array.of(0xbf),
          payload,
        ]),
        { headers: { 'content-type': 'application/json' } },
      ),
    )
    await expect(response.arrayBuffer()).rejects.toThrow(
      'UTF-8 BOM is not accepted',
    )
  })

  test('strips stale representation headers after JSON transformation', async () => {
    const response = createStrippedStream(
      new Response(
        '{"type":"message","content":[{"type":"tool_use","name":"mcp_Read"}]}',
        {
          headers: {
            'content-digest': 'sha-256=:stale:',
            'content-encoding': 'gzip',
            'content-md5': 'stale',
            'content-range': 'bytes 0-9/10',
            digest: 'sha-256=stale',
            etag: '"stale"',
            'content-type': 'application/problem+json',
          },
        },
      ),
    )

    expect(await readText(response)).toContain('"name":"read"')
    for (const name of [
      'content-digest',
      'content-encoding',
      'content-length',
      'content-md5',
      'content-range',
      'digest',
      'etag',
    ]) {
      expect(response.headers.has(name)).toBe(false)
    }
  })

  test('accepts event-stream media type parameters case-insensitively', async () => {
    const response = createStrippedStream(
      sseResponse([TOOL_EVENT], {
        'content-type': 'Text/Event-Stream; charset=utf-8',
      }),
    )

    expect(await readText(response)).toBe(EXPECTED)
  })

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

  test('strips stale representation headers from transformed SSE', () => {
    const response = createStrippedStream(
      sseResponse([TOOL_EVENT], {
        'content-encoding': 'gzip',
        etag: '"stale"',
      }),
    )

    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('etag')).toBeNull()
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
      createStrippedStream(
        sseResponse([
          'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Read"}}',
        ]),
      ),
    )
    expect(output).toBe(
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"read"}}',
    )
  })
})

describe('bounded structured JSON responses', () => {
  const jsonResponse = (
    body: string | Uint8Array | ReadableStream<Uint8Array>,
  ) =>
    createStrippedStream(
      new Response(body, { headers: { 'content-type': 'application/json' } }),
    )

  test('rewrites a tool name at every byte split', async () => {
    const payload =
      '{ "type" : "message", "content" : [{"type":"tool_use","name":"mcp_Read","input":{}}] }'
    const expected = payload.replace('"mcp_Read"', '"read"')
    const bytes = encoder.encode(payload)
    for (let split = 1; split < bytes.byteLength; split += 1) {
      expect(
        await readText(
          jsonResponse(streamOf([bytes.slice(0, split), bytes.slice(split)])),
        ),
      ).toBe(expected)
    }
  })

  test('preserves unrelated paths and decodes candidate escapes', async () => {
    const payload =
      '{"type":"message","metadata":{"name":"mcp_Top"},"content":[{"type":"tool_use","name":"mcp_\\u0052ead","input":{"name":"mcp_Nested","escaped":"\\u0061"}}]}'
    const output = await readText(jsonResponse(payload))
    expect(output).toBe(payload.replace('"mcp_\\u0052ead"', '"read"'))
  })

  test('rejects ambiguous relevant key ordering and duplicates', async () => {
    for (const payload of [
      '{"content":[],"type":"message"}',
      '{"type":"message","content":[{"name":"mcp_Read","type":"tool_use"}]}',
      '{"type":"message","content":[{"type":"tool_use","type":"tool_use","name":"mcp_Read"}]}',
      '{"type":"message","content":[{"type":"tool_use","name":"mcp_Decoy","name":"mcp_Read"}]}',
    ]) {
      await expect(readText(jsonResponse(payload))).rejects.toThrow()
    }
  })

  test('rejects malformed, truncated, and over-deep JSON', async () => {
    await expect(readText(jsonResponse('{"type":"message"'))).rejects.toThrow()
    await expect(
      readText(jsonResponse('{"type":"message"}oops')),
    ).rejects.toThrow()
    let nested = '{}'
    for (let depth = 0; depth <= MAX_JSON_DEPTH; depth += 1) {
      nested = `{"nested":${nested}}`
    }
    await expect(readText(jsonResponse(nested))).rejects.toThrow(
      'Anthropic response JSON exceeds traversal limits',
    )
  })

  test('rewrites a document above the former whole-document limit', async () => {
    const formerWholeDocumentLimit = 5 * 1024 * 1024
    const payload = `{"type":"message","content":[{"type":"tool_use","name":"mcp_Read","input":{"padding":"${'x'.repeat(formerWholeDocumentLimit + 1)}"}}]}`
    const output = await readText(jsonResponse(payload))
    expect(output.startsWith('{"type":"message"')).toBe(true)
    expect(output).toContain('"name":"read"')
    expect(output.length).toBe(payload.length - 4)
  })

  test('bounds tool names and every individual JSON string', async () => {
    const longName = `{"type":"message","content":[{"type":"tool_use","name":"${'x'.repeat(MAX_JSON_TOOL_NAME_BYTES + 1)}"}]}`
    await expect(readText(jsonResponse(longName))).rejects.toThrow(
      `JSON tool name exceeds ${MAX_JSON_TOOL_NAME_BYTES} byte limit`,
    )
    const longString = `{"value":"${'x'.repeat(MAX_JSON_STRING_BYTES + 1)}"}`
    await expect(readText(jsonResponse(longString))).rejects.toThrow(
      `${MAX_JSON_STRING_BYTES} byte string limit`,
    )
  })

  test('applies the tool-name limit to decoded escaped bytes', async () => {
    const escaped = (count: number) =>
      `{"type":"message","content":[{"type":"tool_use","name":"mcp_${'\\u0061'.repeat(count)}"}]}`
    const accepted = await readText(jsonResponse(escaped(1020)))
    expect(JSON.parse(accepted).content[0].name).toBe('a'.repeat(1020))
    await expect(readText(jsonResponse(escaped(1021)))).rejects.toThrow(
      `JSON tool name exceeds ${MAX_JSON_TOOL_NAME_BYTES} byte limit`,
    )
  })

  test('bounds a numeric token split across chunks', async () => {
    const payload = `{"value":${'1'.repeat(MAX_JSON_NUMBER_BYTES + 1)}}`
    const bytes = encoder.encode(payload)
    const split = payload.indexOf('1') + Math.floor(MAX_JSON_NUMBER_BYTES / 2)
    await expect(
      readText(
        jsonResponse(streamOf([bytes.slice(0, split), bytes.slice(split)])),
      ),
    ).rejects.toThrow(`${MAX_JSON_NUMBER_BYTES} byte number limit`)
  })

  test('forwards JSON cancellation and upstream errors', async () => {
    let cancelled = false
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"message",'))
      },
      cancel() {
        cancelled = true
      },
    })
    const reader = jsonResponse(source).body!.getReader()
    await reader.read()
    await reader.cancel()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cancelled).toBe(true)

    const failure = new Error('upstream JSON failed')
    const failed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure)
      },
    })
    await expect(readText(jsonResponse(failed))).rejects.toBe(failure)
  })
})
