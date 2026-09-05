# @1nk1/opencode-anthropic-auth

Private OpenCode 2 plugin for using a Claude Pro/Max subscription through Anthropic OAuth.

> **Compatibility:** OpenCode 2 beta only. Version `2.0.0-beta.8` remains built
> against the exact `@opencode-ai/plugin@0.0.0-beta-18866` SDK pin and has also
> passed isolated compatibility checks on `opencode2 v0.0.0-beta-19151`. Do not
> install it in OpenCode V1.

This package is private and hosted in GitHub Packages. It contains no API keys,
OAuth credentials, user-specific paths, or machine-specific configuration.
Credentials are managed by OpenCode's integration store.

## Authenticate to GitHub Packages

Create a GitHub token with `read:packages`, then configure npm/Bun without
committing the token:

```ini
# ~/.npmrc
@1nk1:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

Export the token in your shell or secret manager:

```sh
export GITHUB_PACKAGES_TOKEN='github-token-with-read-packages'
```

## Install in OpenCode 2

```sh
opencode2 plugin add @1nk1/opencode-anthropic-auth@2.0.0-beta.8
opencode2 service restart
opencode2 plugin list
```

The plugin list must contain:

```text
ink1.anthropic-auth (active)
```

Alternatively, add the pinned package to the V2 configuration:

```json
{
  "plugins": ["@1nk1/opencode-anthropic-auth@2.0.0-beta.8"]
}
```

## Connect Claude Pro/Max

```sh
opencode2 auth login anthropic --method claude-max
```

Complete the browser OAuth flow, then verify the connection:

```sh
opencode2 auth list
opencode2 run --model anthropic/claude-opus-5 \
  'Reply with exactly: OPUS_OAUTH_OK'
```

New OAuth connections receive a privacy-safe label such as
`Claude OAuth • 0123ABCD`. Existing generic labels (`Anthropic`, `Anthropic 2`,
and so on) are not changed automatically. In an OpenCode session, run
`/anthropic-auth-status` to report the active connection label and a short
fingerprint of its non-secret connection ID; the command does not resolve or
display credential values.

### Multiple Anthropic connections

OpenCode creates a separate credential record after every successful OAuth
completion and makes the newly created record active. The plugin never deletes,
renames, rotates between, or falls back to another account automatically.

Use OpenCode's connection UI to rename or explicitly activate a record. The V2
HTTP API exposes the equivalent operations:

- `GET /api/integration/anthropic` — list Anthropic connection records;
- `PATCH /api/credential/{credentialID}` — set a human-readable label;
- `POST /api/credential/{credentialID}/activate` — explicitly make that record
  active.

Treat connection IDs and custom labels as private operational metadata. Verify
the result with `/anthropic-auth-status` before sending a model request. No
credential deletion is required for migration.

## What it does

- registers a `Claude Pro/Max` OAuth method for the native Anthropic integration;
- refreshes rotating OAuth credentials through OpenCode's integration lifecycle;
- injects Anthropic OAuth and required beta headers;
- adds the Claude Code billing envelope and sanitizes known OpenCode fingerprints;
- prefixes request tool names and safely strips prefixes from streamed responses;
- supports arbitrary network chunk boundaries and split UTF-8 code points;
- removes stale `content-length` after response-body rewriting;
- preserves bounded, redacted Anthropic HTTP 429 diagnostics and identifies the
  exact request connection when available;
- prevents retries only for confidently classified subscription/usage blocks;
  transient and unknown rate limits retain OpenCode's retry policy.

## Security

- Never commit GitHub package tokens or Anthropic credentials.
- Pin both this package and OpenCode 2 because the plugin API is still beta.
- OAuth credentials remain in OpenCode's managed integration store.
- OAuth bearer tokens are sent only to `https://api.anthropic.com`; custom
  Anthropic-compatible endpoints are intentionally unsupported.

## Development verification

```sh
bun install --frozen-lockfile
bun test
bun run types
bun run lint
bun run format:check
bun run build
npm pack --dry-run
```

The live model matrix is opt-in because it consumes subscription usage:

```sh
ANTHROPIC_LIVE_SMOKE=1 bun run test:live-models
```

## Attribution and license

Derived from `ex-machina-co/opencode-anthropic-auth` and distributed under the
MIT License. See `LICENSE` and the upstream repository for attribution.
