# @1nk1/opencode-anthropic-auth

Private OpenCode 2 plugin for using a Claude Pro/Max subscription through Anthropic OAuth.

> **Compatibility:** OpenCode 2 beta only. Version `2.0.0-beta.7` targets
> `opencode2 v0.0.0-beta-18866` and `@opencode-ai/plugin@0.0.0-beta-18866`.
> Do not install it in OpenCode V1.

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
opencode2 plugin add @1nk1/opencode-anthropic-auth@2.0.0-beta.7
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
  "plugins": ["@1nk1/opencode-anthropic-auth@2.0.0-beta.7"]
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

## What it does

- registers a `Claude Pro/Max` OAuth method for the native Anthropic integration;
- refreshes rotating OAuth credentials through OpenCode's integration lifecycle;
- injects Anthropic OAuth and required beta headers;
- adds the Claude Code billing envelope and sanitizes known OpenCode fingerprints;
- prefixes request tool names and safely strips prefixes from streamed responses;
- supports arbitrary network chunk boundaries and split UTF-8 code points;
- removes stale `content-length` after response-body rewriting.

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
