import { CLAUDE_CODE_VERSION } from './constants.ts'

export const CLAUDE_CODE_VERSION_ENV_VAR = 'CLAUDE_CODE_VERSION'

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export type ClaudeCodeVersionResolution =
  | { readonly type: 'success'; readonly version: string }
  | { readonly type: 'invalid'; readonly error: string }

/** Resolve and validate the Claude Code version reported to Anthropic. */
export function resolveClaudeCodeVersion(
  raw: string | undefined = process.env[CLAUDE_CODE_VERSION_ENV_VAR],
): ClaudeCodeVersionResolution {
  if (raw === undefined) {
    return { type: 'success', version: CLAUDE_CODE_VERSION }
  }

  const version = raw.trim()
  if (!VERSION_PATTERN.test(version)) {
    return {
      type: 'invalid',
      error:
        `${CLAUDE_CODE_VERSION_ENV_VAR} is set to ${JSON.stringify(raw)}, which is not a ` +
        `Claude Code version. Expected major.minor.patch (for example, ${CLAUDE_CODE_VERSION}). ` +
        `Reporting the bundled version ${CLAUDE_CODE_VERSION} instead; correct or unset ` +
        `${CLAUDE_CODE_VERSION_ENV_VAR} and restart OpenCode to use the override.`,
    }
  }

  return { type: 'success', version }
}
