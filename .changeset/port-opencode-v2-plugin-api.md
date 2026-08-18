---
"@ex-machina/opencode-anthropic-auth": major
---

Port the plugin to the OpenCode v2 plugin API ([#203](https://github.com/ex-machina-co/opencode-anthropic-auth/issues/203)). OpenCode v2 removed the v1 `auth` hook and provider `fetch` override that this plugin previously relied on, so this is a breaking change:

- The package now exports a v2 `Plugin.define({ id, setup })` default export instead of the v1 named `AnthropicAuthPlugin` function. **This release is no longer loadable by OpenCode v1** — pin to a `1.x` release if you're still on OpenCode v1.
- Claude Pro/Max OAuth is now registered through `ctx.integration.transform`, with token refresh wired into OpenCode v2's integration refresh lifecycle (still with a plugin-level single-flight guard to protect against concurrent refresh requests racing a rotating refresh token).
- Anthropic request/response rewriting (OAuth headers, beta flags, body/tool-name transforms, `ANTHROPIC_BASE_URL`) now runs through `ctx.session.hook('http.request' | 'http.response', ...)`, gated to native Anthropic requests using this plugin's OAuth connection.
- Model costs are zeroed for Anthropic models only while this plugin's OAuth connection is active, via `ctx.catalog.transform` kept in sync with `ctx.event.subscribe()`.
- The "Create an API Key" console OAuth method (which minted and stored an Anthropic API key) is not included in this release — OpenCode v2's plugin API doesn't yet support an OAuth flow that ends in a stored API key. Manual API key entry and `ANTHROPIC_API_KEY` continue to work via OpenCode's built-in Anthropic integration.
- `ANTHROPIC_INSECURE` is not supported under OpenCode v2: request hooks can rewrite a `Request` but cannot disable TLS verification for it. The plugin now logs a warning instead of silently leaving it unapplied.
- `@opencode-ai/plugin` is pinned to the `0.0.0-next-17444` prerelease that introduced the v2 promise plugin API used here (`peerDependencies` no longer accepts `*`).
