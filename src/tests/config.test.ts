import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  CLAUDE_CODE_VERSION_ENV_VAR,
  resolveClaudeCodeVersion,
} from '../config'
import { CLAUDE_CODE_VERSION } from '../constants'

describe('resolveClaudeCodeVersion', () => {
  const originalEnv = process.env[CLAUDE_CODE_VERSION_ENV_VAR]

  beforeEach(() => {
    delete process.env[CLAUDE_CODE_VERSION_ENV_VAR]
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[CLAUDE_CODE_VERSION_ENV_VAR]
    } else {
      process.env[CLAUDE_CODE_VERSION_ENV_VAR] = originalEnv
    }
  })

  test('uses the bundled version when unset', () => {
    expect(resolveClaudeCodeVersion()).toEqual({
      type: 'success',
      version: CLAUDE_CODE_VERSION,
    })
  })

  test('reads and trims a valid override', () => {
    process.env[CLAUDE_CODE_VERSION_ENV_VAR] = '  2.9.99\n'

    expect(resolveClaudeCodeVersion()).toEqual({
      type: 'success',
      version: '2.9.99',
    })
  })

  test.each([
    ['empty', ''],
    ['two components', '2.9'],
    ['four components', '2.9.99.1'],
    ['prerelease suffix', '2.9.99-beta.1'],
    ['v prefix', 'v2.9.99'],
    ['leading-zero component', '02.1.258'],
    ['non-numeric component', '2.x.99'],
    ['tag', 'latest'],
  ])('rejects a malformed override (%s)', (_label, raw) => {
    const result = resolveClaudeCodeVersion(raw)

    expect(result.type).toBe('invalid')
    if (result.type === 'invalid') {
      expect(result.error).toContain(CLAUDE_CODE_VERSION_ENV_VAR)
      expect(result.error).toContain('major.minor.patch')
      expect(result.error).toContain(CLAUDE_CODE_VERSION)
    }
  })
})
