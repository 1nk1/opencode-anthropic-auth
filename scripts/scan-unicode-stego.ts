import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'

export type UnicodeStegoFinding = {
  path: string
  line: number
  column: number
  codePoint?: string
  kind: string
  detail: string
}

const ignoredDirectories = new Set(['.git', 'node_modules'])
const allowedBinaryExtensions = new Set([
  '.avif',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.pdf',
  '.png',
  '.webp',
])
const latinPattern = /\p{Script=Latin}/u
const letterPattern = /\p{L}/u
const markPattern = /\p{M}/u
const formatPattern = /\p{Cf}/u
const identifierPattern = /[\p{L}\p{M}\p{N}_$]+/gu

function codePointLabel(value: number): string {
  return `U+${value.toString(16).toUpperCase().padStart(4, '0')}`
}

function isNoncharacter(value: number): boolean {
  return (
    (value >= 0xfdd0 && value <= 0xfdef) ||
    (value & 0xffff) === 0xfffe ||
    (value & 0xffff) === 0xffff
  )
}

function classifyCodePoint(value: number): string | undefined {
  const character = String.fromCodePoint(value)
  if (
    (value >= 0x00 && value <= 0x08) ||
    value === 0x0b ||
    value === 0x0c ||
    (value >= 0x0e && value <= 0x1f) ||
    (value >= 0x7f && value <= 0x9f)
  ) {
    return 'control character'
  }
  if (
    value === 0x00ad ||
    value === 0x034f ||
    value === 0x061c ||
    value === 0x180e ||
    (value >= 0x200b && value <= 0x200f) ||
    (value >= 0x202a && value <= 0x202e) ||
    (value >= 0x2060 && value <= 0x206f) ||
    value === 0xfeff ||
    (value >= 0xfff9 && value <= 0xfffb)
  ) {
    return 'invisible or directional format character'
  }
  if (
    value === 0x00a0 ||
    value === 0x1680 ||
    (value >= 0x2000 && value <= 0x200a) ||
    value === 0x202f ||
    value === 0x205f ||
    value === 0x2800 ||
    value === 0x3000 ||
    value === 0x3164 ||
    value === 0xffa0
  ) {
    return 'non-standard or invisible spacing character'
  }
  if (
    (value >= 0xfe00 && value <= 0xfe0f) ||
    (value >= 0xe0100 && value <= 0xe01ef)
  ) {
    return 'variation selector'
  }
  if (value >= 0xe0000 && value <= 0xe007f) {
    return 'Unicode tag character'
  }
  if (
    (value >= 0xe000 && value <= 0xf8ff) ||
    (value >= 0xf0000 && value <= 0xffffd) ||
    (value >= 0x100000 && value <= 0x10fffd)
  ) {
    return 'private-use character'
  }
  if (formatPattern.test(character)) return 'Unicode format character'
  if (markPattern.test(character)) return 'combining or modifier mark'
  if (isNoncharacter(value)) return 'Unicode noncharacter'
  return undefined
}

function lineAndColumn(text: string, offset: number): [number, number] {
  let line = 1
  let column = 1
  for (let index = 0; index < offset; index++) {
    if (text.charCodeAt(index) === 0x0a) {
      line++
      column = 1
    } else {
      column++
    }
  }
  return [line, column]
}

export function scanText(path: string, text: string): UnicodeStegoFinding[] {
  const findings: UnicodeStegoFinding[] = []

  for (let offset = 0; offset < text.length; ) {
    const value = text.codePointAt(offset)
    if (value === undefined) break
    const kind = classifyCodePoint(value)
    if (kind) {
      const [line, column] = lineAndColumn(text, offset)
      findings.push({
        path,
        line,
        column,
        codePoint: codePointLabel(value),
        kind,
        detail: `${codePointLabel(value)}: ${kind}`,
      })
    }
    offset += value > 0xffff ? 2 : 1
  }

  for (const match of text.matchAll(identifierPattern)) {
    const token = match[0]
    const hasLatin = [...token].some((character) =>
      latinPattern.test(character),
    )
    const hasNonLatinLetter = [...token].some(
      (character) =>
        letterPattern.test(character) && !latinPattern.test(character),
    )
    if (hasLatin && hasNonLatinLetter) {
      const offset = match.index ?? 0
      const [line, column] = lineAndColumn(text, offset)
      findings.push({
        path,
        line,
        column,
        kind: 'mixed-script identifier',
        detail: `mixed Latin and non-Latin token: ${JSON.stringify(token)}`,
      })
    }
    if (
      [...token].some((character) => (character.codePointAt(0) ?? 0) > 0x7f) &&
      token.normalize('NFKC') !== token
    ) {
      const offset = match.index ?? 0
      const [line, column] = lineAndColumn(text, offset)
      findings.push({
        path,
        line,
        column,
        kind: 'compatibility-normalized identifier',
        detail: `identifier changes under NFKC normalization: ${JSON.stringify(token)}`,
      })
    }
  }

  return findings
}

function collectDirectory(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...collectDirectory(path))
    else if (entry.isFile()) files.push(path)
    else if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to scan symbolic link: ${path}`)
    }
  }
  return files
}

function trackedFiles(): string[] {
  const result = Bun.spawnSync(['git', 'ls-files', '-z'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim())
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split('\0')
    .filter(Boolean)
    .map((path) => resolve(path))
}

function inputFiles(inputs: string[]): string[] {
  const paths =
    inputs.length > 0 ? inputs.map((path) => resolve(path)) : trackedFiles()
  const files = new Set<string>()
  for (const path of paths) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to scan symbolic link: ${path}`)
    }
    if (stat.isDirectory()) {
      for (const file of collectDirectory(path)) files.add(file)
    } else if (stat.isFile()) {
      files.add(path)
    }
  }
  return [...files].sort()
}

export function scanFiles(
  inputs: string[],
  options?: { requireText?: boolean },
): {
  findings: UnicodeStegoFinding[]
  scanned: number
  skippedBinary: number
} {
  const findings: UnicodeStegoFinding[] = []
  let scanned = 0
  let skippedBinary = 0
  const decoder = new TextDecoder('utf-8', { fatal: true })

  for (const path of inputFiles(inputs)) {
    const displayPath = relative(process.cwd(), path) || path
    const pathFindings = scanText(displayPath, displayPath)
    if (pathFindings.length > 0) findings.push(...pathFindings)

    const extension = extname(path).toLowerCase()
    if (allowedBinaryExtensions.has(extension)) {
      if (options?.requireText) {
        findings.push({
          path: displayPath,
          line: 1,
          column: 1,
          kind: 'binary file',
          detail: 'binary files are not allowed in this scan',
        })
      } else {
        skippedBinary++
      }
      continue
    }

    try {
      const text = decoder.decode(readFileSync(path))
      findings.push(...scanText(displayPath, text))
      scanned++
    } catch (error) {
      if (error instanceof TypeError) {
        findings.push({
          path: displayPath,
          line: 1,
          column: 1,
          kind: 'invalid UTF-8',
          detail: 'file is not valid UTF-8 text',
        })
        continue
      }
      throw error
    }
  }

  return { findings, scanned, skippedBinary }
}

function main(): void {
  const arguments_ = process.argv.slice(2)
  const requireText = arguments_.includes('--require-text')
  const inputs = arguments_.filter((argument) => argument !== '--require-text')
  const result = scanFiles(inputs, { requireText })
  if (result.findings.length > 0) {
    console.error(
      `Unicode steganography scan failed: ${result.findings.length} finding(s)`,
    )
    for (const finding of result.findings) {
      console.error(
        `${finding.path}:${finding.line}:${finding.column} ${finding.detail}`,
      )
    }
    process.exitCode = 1
    return
  }

  console.log(
    `Unicode steganography scan passed: ${result.scanned} text file(s), ${result.skippedBinary} binary file(s) skipped`,
  )
}

if (import.meta.main) main()
