import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanFiles, scanText } from './scan-unicode-stego'

const character = (value: number): string => String.fromCodePoint(value)
const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'watermark-scan-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Unicode steganography scanner', () => {
  test.each([
    [0x200b, 'invisible or directional format character'],
    [0x202e, 'invisible or directional format character'],
    [0xfe0f, 'variation selector'],
    [0xe0061, 'Unicode tag character'],
    [0xe123, 'private-use character'],
    [0x00a0, 'non-standard or invisible spacing character'],
  ])('detects suspicious code point U+%x', (value, expectedKind) => {
    const findings = scanText('fixture.ts', `safe${character(value)}text`)

    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe(expectedKind)
    expect(findings[0]?.codePoint).toBe(
      `U+${value.toString(16).toUpperCase().padStart(4, '0')}`,
    )
  })

  test('detects a mixed Latin and Cyrillic identifier', () => {
    const cyrillicA = character(0x0430)
    const findings = scanText('fixture.ts', `const p${cyrillicA}ypal = true`)

    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('mixed-script identifier')
  })

  test('detects Latin mixed with another non-Latin script', () => {
    const hebrewAlef = character(0x05d0)
    const findings = scanText('fixture.ts', `const p${hebrewAlef}ypal = true`)

    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('mixed-script identifier')
  })

  test('detects combining marks and compatibility identifiers', () => {
    const combiningAcute = character(0x0301)
    const fullwidthA = character(0xff21)

    expect(scanText('fixture.ts', `pa${combiningAcute}ypal`)).toContainEqual(
      expect.objectContaining({ kind: 'combining or modifier mark' }),
    )
    expect(scanText('fixture.ts', `${fullwidthA}dmin`)).toContainEqual(
      expect.objectContaining({ kind: 'compatibility-normalized identifier' }),
    )
  })

  test('allows visible Unicode in prose and UTF-8 tests', () => {
    const cyrillicWord = [0x041f, 0x0440, 0x0438, 0x0432, 0x0435, 0x0442]
      .map(character)
      .join('')
    const visible = `${cyrillicWord} ${character(0x1f680)} ${character(0x2014)}`

    expect(scanText('fixture.ts', visible)).toEqual([])
  })

  test('reports the exact line and column', () => {
    const findings = scanText('fixture.ts', `first\nabc${character(0x2060)}def`)

    expect(findings[0]).toMatchObject({ line: 2, column: 4 })
  })

  test('scans nested directories and rejects invalid UTF-8', () => {
    const directory = temporaryDirectory()
    const nested = join(directory, 'nested')
    mkdirSync(nested)
    writeFileSync(join(nested, 'clean.ts'), 'const clean = true\n')
    writeFileSync(join(nested, 'invalid.ts'), Uint8Array.from([0xff, 0xfe]))

    const result = scanFiles([directory])

    expect(result.scanned).toBe(1)
    expect(result.findings).toContainEqual(
      expect.objectContaining({ kind: 'invalid UTF-8' }),
    )
  })

  test('allows known source assets but rejects them in text-only mode', () => {
    const directory = temporaryDirectory()
    const image = join(directory, 'fixture.jpg')
    writeFileSync(image, Uint8Array.from([0xff, 0xd8, 0xff]))

    expect(scanFiles([directory])).toMatchObject({
      findings: [],
      skippedBinary: 1,
    })
    expect(
      scanFiles([directory], { requireText: true }).findings,
    ).toContainEqual(expect.objectContaining({ kind: 'binary file' }))
  })

  test('rejects symbolic links', () => {
    const directory = temporaryDirectory()
    const target = join(directory, 'target.ts')
    const link = join(directory, 'link.ts')
    writeFileSync(target, 'const clean = true\n')
    symlinkSync(target, link)

    expect(() => scanFiles([directory])).toThrow(
      'Refusing to scan symbolic link',
    )
  })

  test('prepack scans the built package as text-only', () => {
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
    )

    expect(packageJson.scripts.prepack).toContain(
      'bun run scan:unicode-stego --require-text dist',
    )
    expect(packageJson.scripts.verify).toContain('bun run scan:unicode-stego')
  })
})
