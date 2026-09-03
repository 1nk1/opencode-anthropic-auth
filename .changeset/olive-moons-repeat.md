---
'@ex-machina/opencode-anthropic-auth': patch
---

Allow the reported Claude Code version to be configured via the `ANTHROPIC_CLAUDE_CODE_VERSION` environment variable. Anthropic gates model access on this value server-side and moves that gate on its own schedule, so a newly-gated model previously required waiting for a plugin release. Setting `ANTHROPIC_CLAUDE_CODE_VERSION` to a `major.minor.patch` value now overrides the bundled default for both places the version is reported — the `user-agent` header and the billing header's `cc_version` — which are resolved from a single value so they cannot disagree. The variable is read once at startup; a malformed value is logged as an error and the bundled version is used instead.
