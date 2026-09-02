import { type ParsedTokenInfo, Tokenizer, TokenType } from '@streamparser/json'

export const MAX_JSON_TOOL_NAME_BYTES = 1024
export const MAX_JSON_STRING_BYTES = 8 * 1024 * 1024
export const MAX_JSON_NUMBER_BYTES = 128
export const MAX_JSON_DEPTH = 256

const TOKENIZER_SLICE_BYTES = 1024
const encoder = new TextEncoder()

type ObjectState = 'key-or-end' | 'key' | 'colon' | 'value' | 'comma-or-end'
type ArrayState = 'value-or-end' | 'value' | 'comma-or-end'
type FrameRole = 'root' | 'content-array' | 'block' | 'other'

type ObjectFrame = {
  mode: 'object'
  state: ObjectState
  role: FrameRole
  key?: string
  typeSeen: boolean
  objectType?: string
  seenType: boolean
  seenName: boolean
  seenContent: boolean
  seenContentBlock: boolean
}

type ArrayFrame = {
  mode: 'array'
  state: ArrayState
  role: FrameRole
}

type Frame = ObjectFrame | ArrayFrame

type PendingToken = {
  offset: number
  token: TokenType
  replacement?: Uint8Array
}

class ByteQueue {
  private chunks: Uint8Array[] = []
  private offset = 0
  private length = 0

  append(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return
    this.chunks.push(bytes.slice())
    this.length += bytes.byteLength
  }

  get start(): number {
    return this.offset
  }

  get size(): number {
    return this.length
  }

  takeTo(end: number): Uint8Array {
    const count = end - this.offset
    if (count < 0 || count > this.length) throw malformedJson()
    const output = new Uint8Array(count)
    let written = 0
    while (written < count) {
      const chunk = this.chunks[0]
      if (!chunk) throw malformedJson()
      const consumed = Math.min(chunk.byteLength, count - written)
      output.set(chunk.subarray(0, consumed), written)
      written += consumed
      if (consumed === chunk.byteLength) this.chunks.shift()
      else this.chunks[0] = chunk.subarray(consumed)
    }
    this.offset = end
    this.length -= count
    return output
  }

  bytesFrom(start: number): Uint8Array {
    if (start < this.offset || start > this.offset + this.length) {
      throw malformedJson()
    }
    const skipped = start - this.offset
    const output = new Uint8Array(this.length - skipped)
    let sourceOffset = 0
    let outputOffset = 0
    for (const chunk of this.chunks) {
      const chunkEnd = sourceOffset + chunk.byteLength
      if (chunkEnd > skipped) {
        const begin = Math.max(0, skipped - sourceOffset)
        output.set(chunk.subarray(begin), outputOffset)
        outputOffset += chunk.byteLength - begin
      }
      sourceOffset = chunkEnd
    }
    return output
  }
}

function malformedJson(detail?: string): Error {
  return new Error(
    detail
      ? `Malformed Anthropic response JSON: ${detail}`
      : 'Malformed Anthropic response JSON',
  )
}

function rawTokenLength(bytes: Uint8Array, token: TokenType): number {
  if (token === TokenType.STRING) {
    let escaped = false
    for (let index = 1; index < bytes.byteLength; index += 1) {
      const byte = bytes[index]
      if (escaped) escaped = false
      else if (byte === 0x5c) escaped = true
      else if (byte === 0x22) return index + 1
    }
    return 0
  }
  if (
    token === TokenType.LEFT_BRACE ||
    token === TokenType.RIGHT_BRACE ||
    token === TokenType.LEFT_BRACKET ||
    token === TokenType.RIGHT_BRACKET ||
    token === TokenType.COLON ||
    token === TokenType.COMMA
  ) {
    return 1
  }
  if (token === TokenType.TRUE || token === TokenType.NULL) return 4
  if (token === TokenType.FALSE) return 5
  if (token === TokenType.NUMBER) {
    let index = 0
    while (index < bytes.byteLength) {
      const byte = bytes[index]
      if (
        byte === 0x20 ||
        byte === 0x09 ||
        byte === 0x0a ||
        byte === 0x0d ||
        byte === 0x2c ||
        byte === 0x5d ||
        byte === 0x7d
      ) {
        break
      }
      index += 1
    }
    return index
  }
  return 0
}

function objectFrame(role: FrameRole): ObjectFrame {
  return {
    mode: 'object',
    state: 'key-or-end',
    role,
    typeSeen: false,
    seenType: false,
    seenName: false,
    seenContent: false,
    seenContentBlock: false,
  }
}

function isPrimitive(token: TokenType): boolean {
  return (
    token === TokenType.STRING ||
    token === TokenType.NUMBER ||
    token === TokenType.TRUE ||
    token === TokenType.FALSE ||
    token === TokenType.NULL
  )
}

function enqueue(
  controller: TransformStreamDefaultController<Uint8Array>,
  bytes: Uint8Array,
): void {
  if (bytes.byteLength > 0) controller.enqueue(bytes)
}

export function createBoundedJsonToolNameStream(
  body: ReadableStream<Uint8Array>,
  toolPrefix: string,
  rewriteName: (nameWithoutPrefix: string) => string,
): ReadableStream<Uint8Array> {
  const raw = new ByteQueue()
  const stack: Frame[] = []
  let absoluteOffset = 0
  let rootComplete = false
  let pending: PendingToken | undefined
  let outputController: TransformStreamDefaultController<Uint8Array>

  const top = (): Frame | undefined => stack.at(-1)

  const expectingCandidateName = (): boolean => {
    const frame = top()
    return (
      frame?.mode === 'object' &&
      frame.role === 'block' &&
      frame.state === 'value' &&
      frame.key === 'name' &&
      frame.typeSeen &&
      frame.objectType === 'tool_use'
    )
  }

  const finishPending = (nextOffset: number): void => {
    if (!pending) {
      enqueue(outputController, raw.takeTo(nextOffset))
      return
    }
    const segmentStart = raw.start
    const segment = raw.takeTo(nextOffset)
    const tokenStart = pending.offset - segmentStart
    if (tokenStart < 0 || tokenStart > segment.byteLength) throw malformedJson()
    if (!pending.replacement) {
      enqueue(outputController, segment)
      pending = undefined
      return
    }
    const tokenLength = rawTokenLength(
      segment.subarray(tokenStart),
      pending.token,
    )
    if (tokenLength === 0) throw malformedJson('missing replacement token')
    const output = new Uint8Array(
      segment.byteLength - tokenLength + pending.replacement.byteLength,
    )
    output.set(segment.subarray(0, tokenStart))
    output.set(pending.replacement, tokenStart)
    output.set(
      segment.subarray(tokenStart + tokenLength),
      tokenStart + pending.replacement.byteLength,
    )
    enqueue(outputController, output)
    pending = undefined
  }

  const completeValue = (): void => {
    const frame = top()
    if (!frame) {
      if (rootComplete) throw malformedJson('multiple root values')
      rootComplete = true
      return
    }
    if (frame.mode === 'object') {
      if (frame.state !== 'value') throw malformedJson('unexpected value')
      frame.state = 'comma-or-end'
      frame.key = undefined
    } else {
      if (frame.state !== 'value' && frame.state !== 'value-or-end') {
        throw malformedJson('unexpected array value')
      }
      frame.state = 'comma-or-end'
    }
  }

  const requireValuePosition = (): Frame | undefined => {
    const frame = top()
    if (!frame) {
      if (rootComplete) throw malformedJson('multiple root values')
      return undefined
    }
    if (frame.mode === 'object' && frame.state !== 'value') {
      throw malformedJson('object value is out of place')
    }
    if (
      frame.mode === 'array' &&
      frame.state !== 'value' &&
      frame.state !== 'value-or-end'
    ) {
      throw malformedJson('array value is out of place')
    }
    return frame
  }

  const containerRole = (
    parent: Frame | undefined,
    token: TokenType.LEFT_BRACE | TokenType.LEFT_BRACKET,
  ): FrameRole => {
    if (!parent) return 'root'
    if (
      parent.mode === 'array' &&
      parent.role === 'content-array' &&
      token === TokenType.LEFT_BRACE
    ) {
      return 'block'
    }
    if (parent.mode !== 'object' || parent.role !== 'root') return 'other'
    if (parent.key === 'content' && token === TokenType.LEFT_BRACKET) {
      if (!parent.typeSeen) throw malformedJson('content precedes root type')
      return parent.objectType === 'message' ? 'content-array' : 'other'
    }
    if (parent.key === 'content_block' && token === TokenType.LEFT_BRACE) {
      if (!parent.typeSeen) {
        throw malformedJson('content_block precedes root type')
      }
      return parent.objectType === 'content_block_start' ? 'block' : 'other'
    }
    return 'other'
  }

  const startContainer = (
    token: TokenType.LEFT_BRACE | TokenType.LEFT_BRACKET,
  ): void => {
    const parent = requireValuePosition()
    if (stack.length >= MAX_JSON_DEPTH) {
      throw new Error('Anthropic response JSON exceeds traversal limits')
    }
    const role = containerRole(parent, token)
    stack.push(
      token === TokenType.LEFT_BRACE
        ? objectFrame(role)
        : { mode: 'array', state: 'value-or-end', role },
    )
  }

  const recordKey = (frame: ObjectFrame, key: string): void => {
    if (frame.role === 'root') {
      if (key === 'type') {
        if (frame.seenType) throw malformedJson('duplicate root type')
        frame.seenType = true
      } else if (key === 'content') {
        if (frame.seenContent) throw malformedJson('duplicate root content')
        frame.seenContent = true
      } else if (key === 'content_block') {
        if (frame.seenContentBlock) {
          throw malformedJson('duplicate root content_block')
        }
        frame.seenContentBlock = true
      }
    } else if (frame.role === 'block') {
      if (key === 'type') {
        if (frame.seenType) throw malformedJson('duplicate block type')
        frame.seenType = true
      } else if (key === 'name') {
        if (frame.seenName) throw malformedJson('duplicate block name')
        frame.seenName = true
      }
    }
    frame.key = key
    frame.state = 'colon'
  }

  const processPrimitive = (info: ParsedTokenInfo): Uint8Array | undefined => {
    const frame = requireValuePosition()
    let replacement: Uint8Array | undefined
    if (frame?.mode === 'object') {
      if (
        frame.key === 'type' &&
        (frame.role === 'root' || frame.role === 'block')
      ) {
        frame.typeSeen = true
        frame.objectType =
          info.token === TokenType.STRING ? String(info.value) : undefined
      }
      if (frame.role === 'block' && frame.key === 'name') {
        if (!frame.typeSeen) throw malformedJson('name precedes block type')
        if (
          frame.objectType === 'tool_use' &&
          info.token === TokenType.STRING
        ) {
          const name = String(info.value)
          if (encoder.encode(name).byteLength > MAX_JSON_TOOL_NAME_BYTES) {
            throw new Error(
              `JSON tool name exceeds ${MAX_JSON_TOOL_NAME_BYTES} byte limit`,
            )
          }
          if (name.startsWith(toolPrefix)) {
            replacement = encoder.encode(
              JSON.stringify(rewriteName(name.slice(toolPrefix.length))),
            )
          }
        }
      }
    }
    completeValue()
    return replacement
  }

  const closeContainer = (token: TokenType): void => {
    const frame = top()
    if (!frame) throw malformedJson('unexpected container close')
    const expectedMode =
      token === TokenType.RIGHT_BRACE
        ? 'object'
        : token === TokenType.RIGHT_BRACKET
          ? 'array'
          : undefined
    if (frame.mode !== expectedMode) throw malformedJson('mismatched close')
    const canClose =
      frame.mode === 'object'
        ? frame.state === 'key-or-end' || frame.state === 'comma-or-end'
        : frame.state === 'value-or-end' || frame.state === 'comma-or-end'
    if (!canClose) throw malformedJson('incomplete container')
    stack.pop()
    completeValue()
  }

  const onToken = (info: ParsedTokenInfo): void => {
    if (info.partial) {
      const sourceBytes = absoluteOffset - info.offset
      const candidateNameBytes = expectingCandidateName()
        ? encoder.encode(String(info.value)).byteLength
        : 0
      if (
        info.token === TokenType.STRING &&
        (expectingCandidateName()
          ? candidateNameBytes > MAX_JSON_TOOL_NAME_BYTES
          : sourceBytes > MAX_JSON_STRING_BYTES)
      ) {
        throw new Error(
          expectingCandidateName()
            ? `JSON tool name exceeds ${MAX_JSON_TOOL_NAME_BYTES} byte limit`
            : `Anthropic response JSON exceeds ${MAX_JSON_STRING_BYTES} byte string limit`,
        )
      }
      if (
        info.token === TokenType.NUMBER &&
        sourceBytes > MAX_JSON_NUMBER_BYTES
      ) {
        throw new Error(
          `Anthropic response JSON exceeds ${MAX_JSON_NUMBER_BYTES} byte number limit`,
        )
      }
      return
    }

    const source = raw.bytesFrom(info.offset)
    const sourceLength = rawTokenLength(source, info.token)
    if (sourceLength === 0) throw malformedJson('incomplete token')
    if (
      info.token === TokenType.STRING &&
      sourceLength > MAX_JSON_STRING_BYTES
    ) {
      throw new Error(
        `Anthropic response JSON exceeds ${MAX_JSON_STRING_BYTES} byte string limit`,
      )
    }
    if (
      info.token === TokenType.NUMBER &&
      sourceLength > MAX_JSON_NUMBER_BYTES
    ) {
      throw new Error(
        `Anthropic response JSON exceeds ${MAX_JSON_NUMBER_BYTES} byte number limit`,
      )
    }

    finishPending(info.offset)
    pending = { offset: info.offset, token: info.token }
    const frame = top()

    if (
      info.token === TokenType.STRING &&
      frame?.mode === 'object' &&
      (frame.state === 'key-or-end' || frame.state === 'key')
    ) {
      recordKey(frame, String(info.value))
      return
    }

    if (
      info.token === TokenType.LEFT_BRACE ||
      info.token === TokenType.LEFT_BRACKET
    ) {
      startContainer(info.token)
    } else if (isPrimitive(info.token)) {
      pending.replacement = processPrimitive(info)
    } else if (info.token === TokenType.COLON) {
      if (frame?.mode !== 'object' || frame.state !== 'colon') {
        throw malformedJson('unexpected colon')
      }
      frame.state = 'value'
    } else if (info.token === TokenType.COMMA) {
      if (frame?.state !== 'comma-or-end') {
        throw malformedJson('unexpected comma')
      }
      frame.state = frame.mode === 'object' ? 'key' : 'value'
    } else if (
      info.token === TokenType.RIGHT_BRACE ||
      info.token === TokenType.RIGHT_BRACKET
    ) {
      closeContainer(info.token)
    } else {
      throw malformedJson('unexpected token')
    }
  }

  const tokenizer = new Tokenizer({
    emitPartialTokens: true,
    numberBufferSize: MAX_JSON_NUMBER_BYTES,
    stringBufferSize: 64 * 1024,
  })
  tokenizer.onToken = onToken

  const preamble: number[] = []
  let preambleChecked = false
  const feed = (chunk: Uint8Array): void => {
    for (
      let offset = 0;
      offset < chunk.byteLength;
      offset += TOKENIZER_SLICE_BYTES
    ) {
      const slice = chunk.subarray(
        offset,
        Math.min(offset + TOKENIZER_SLICE_BYTES, chunk.byteLength),
      )
      raw.append(slice)
      absoluteOffset += slice.byteLength
      tokenizer.write(slice)
      if (raw.size > MAX_JSON_STRING_BYTES + TOKENIZER_SLICE_BYTES * 2) {
        throw new Error('Anthropic response JSON exceeds bounded token buffer')
      }
    }
  }
  const rejectBom = (): void => {
    if (preamble[0] === 0xef && preamble[1] === 0xbb && preamble[2] === 0xbf) {
      throw malformedJson('UTF-8 BOM is not accepted')
    }
  }
  const accept = (chunk: Uint8Array): void => {
    let offset = 0
    if (!preambleChecked) {
      while (preamble.length < 3 && offset < chunk.byteLength) {
        preamble.push(chunk[offset++] ?? 0)
      }
      if (preamble.length < 3) return
      rejectBom()
      preambleChecked = true
      feed(Uint8Array.from(preamble))
      preamble.length = 0
    }
    feed(chunk.subarray(offset))
  }

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        outputController = controller
      },
      transform(chunk) {
        accept(chunk)
      },
      flush() {
        if (!preambleChecked) {
          rejectBom()
          preambleChecked = true
          feed(Uint8Array.from(preamble))
          preamble.length = 0
        }
        tokenizer.end()
        if (!rootComplete || stack.length > 0 || !pending) {
          throw new Error('Malformed or truncated Anthropic response JSON')
        }
        finishPending(absoluteOffset)
        if (raw.size !== 0) throw malformedJson('unflushed bytes')
      },
    }),
  )
}
