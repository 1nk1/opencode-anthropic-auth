import { describe, expect, test } from 'bun:test'

describe('published plugin entrypoint', () => {
  test('exports one OpenCode v2 plugin as default', async () => {
    const module = await import('../../dist/index.js')

    expect(Object.keys(module)).toEqual(['default'])
    expect(module.default.id).toBe('ex-machina.anthropic-auth')
    expect(module.default.setup).toBeFunction()
  })
})
