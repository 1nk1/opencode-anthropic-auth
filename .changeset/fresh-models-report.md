---
'@ex-machina/opencode-anthropic-auth': patch
---

Allow `CLAUDE_CODE_VERSION` to override the bundled Claude Code version reported in both the user-agent and billing headers. Anthropic gates new models on this value, so users can now adopt a required version without waiting for a plugin release. Invalid values are logged and ignored.
