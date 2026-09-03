import { CLAUDE_CODE_VERSION } from './constants.ts'

/**
 * Environment variable that overrides the reported Claude Code version.
 *
 * Anthropic gates model access on the reported version server-side, and that
 * gate moves on Anthropic's schedule rather than this plugin's release
 * schedule. The override lets users unblock a newly-gated model without
 * waiting for a published bump.
 */
export const ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR =
  'ANTHROPIC_CLAUDE_CODE_VERSION'

/** Claude Code releases are `major.minor.patch` with numeric components. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/**
 * Outcome of reading the version override.
 *
 * The invalid arm carries no version: a malformed override must never reach
 * the request path, so callers cannot accidentally report one.
 */
export type ClaudeCodeVersionResolution =
  | { type: 'success'; version: string }
  | { type: 'invalid'; error: string }

/**
 * Resolve the Claude Code version to report to Anthropic.
 *
 * Returns the bundled version when the override is unset. A set override is
 * trimmed and must look like a Claude Code release; anything else resolves to
 * `invalid` with a message describing how to correct it. Never throws.
 */
export function resolveClaudeCodeVersion(
  raw: string | undefined = process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR],
): ClaudeCodeVersionResolution {
  if (raw === undefined) {
    return { type: 'success', version: CLAUDE_CODE_VERSION }
  }

  const trimmed = raw.trim()
  if (!VERSION_PATTERN.test(trimmed)) {
    return {
      type: 'invalid',
      error:
        `${ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR} is set to ${JSON.stringify(raw)}, which is not a ` +
        `Claude Code version. Expected major.minor.patch (e.g. ${CLAUDE_CODE_VERSION}). ` +
        `Reporting the bundled version ${CLAUDE_CODE_VERSION} instead — correct or unset ` +
        `${ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR} and restart OpenCode to use the override.`,
    }
  }

  return { type: 'success', version: trimmed }
}
