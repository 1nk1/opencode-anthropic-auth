# OpenCode Anthropic Auth Plugin

[![OpenCode v1 — npm latest tag](https://img.shields.io/npm/v/%40ex-machina%2Fopencode-anthropic-auth/latest?label=OpenCode%20v1%20(latest))](https://www.npmjs.com/package/@ex-machina/opencode-anthropic-auth?activeTab=versions)
[![OpenCode v2 — npm next tag](https://img.shields.io/npm/v/%40ex-machina%2Fopencode-anthropic-auth/next?label=OpenCode%20v2%20(next))](https://www.npmjs.com/package/@ex-machina/opencode-anthropic-auth?activeTab=versions)

> [!WARNING]
> This plugin comes with no guarantees. You might be banned for breaking the TOS, you might not be. I don't work at Anthropic, nor am I an attorney.
>
> Use your best judgment and don't try to abuse the subscriptions. Plugins like oh-my-openagent are _known_ to trigger bans. Please be careful when using Ralph loops or insanely heavy usage patterns.

> [!IMPORTANT]
> If you are seeing issues, try `rm -rf ~/.cache/opencode/packages/@ex-machina` and confirm that your `opencode.json` uses the plugin release line for your OpenCode version.
>
> Try this FIRST before making an Issue. Thanks!

An [OpenCode](https://github.com/anomalyco/opencode) plugin that provides Anthropic OAuth authentication, enabling Claude Pro/Max users to use their subscription directly with OpenCode.

## Version support

| OpenCode version | Plugin release | Support branch | npm dist-tag | Configuration key |
|------------------|----------------|----------------|--------------|-------------------|
| OpenCode v1 | 1.x | [`main`](https://github.com/ex-machina-co/opencode-anthropic-auth/tree/main) | `latest` | `plugin` |
| OpenCode v2 | 2.x prereleases | [`v2/main`](https://github.com/ex-machina-co/opencode-anthropic-auth/tree/v2/main) | `next` | `plugins` |

Both release lines use the same npm package. They are not cross-compatible: the v1 plugin does not load in OpenCode v2, and the v2 plugin does not load in OpenCode v1. OpenCode v2's plugin API is still beta, so review the changelog before upgrading either side.

## Usage

> [!TIP]
> Pin an exact plugin version for a stable setup that changes only when you choose to upgrade. If you intentionally want automatic updates, use the moving npm tag for your OpenCode release line.
>
> This applies to every OpenCode plugin: an unpinned or moving-tag dependency can install new code on startup, so only track automatic updates from publishers you trust.

OpenCode v2 uses the plural `plugins` configuration key. Because npm's default tag points to the v1 line, specify `@next` if you want to track the newest v2 prerelease:

```json
{
  "plugins": ["@ex-machina/opencode-anthropic-auth@next"]
}
```

For a stable setup, look up the exact version currently published on `next`:

```bash
npm view @ex-machina/opencode-anthropic-auth dist-tags.next
```

Substitute the command output for `<version>`:

```json
{
  "plugins": ["@ex-machina/opencode-anthropic-auth@<version>"]
}
```

## Authentication Methods

- **Claude Pro/Max** - OAuth flow via `claude.ai` for Pro/Max subscribers. Uses your existing subscription at no additional API cost.
    - run the `/connect` command, select `Anthropic` -> `Claude Pro/Max` and do OAuth
- **Manually enter API Key / `ANTHROPIC_API_KEY`** - Handled by OpenCode's built-in Anthropic integration, not by this plugin.

> [!NOTE]
> The v1 release of this plugin also offered a "Create an API Key" OAuth flow (via `console.anthropic.com`) that minted and stored an API key for you. OpenCode v2's plugin API does not yet support an OAuth authorization flow that ends in a stored API key, so that flow isn't available in this v2 release. Use manual API key entry (or `ANTHROPIC_API_KEY`) in the meantime — see [issue #203](https://github.com/ex-machina-co/opencode-anthropic-auth/issues/203) for status.
>
> OpenCode v2 continues to display Anthropic's API prices for these models even though requests authenticated through Claude Pro/Max use the subscription. Dynamic cost display is deferred until the beta plugin API can safely cancel the required connection event subscription.

## Configuration

The plugin supports the following environment variables:

| Variable                          | Description                                                                                                                                                                                 |
|-----------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `ANTHROPIC_BASE_URL`              | Override the API endpoint URL (e.g. for proxying). Must be a valid HTTP(S) URL.                                                                                                             |
| `ANTHROPIC_INSECURE`              | **Not supported under OpenCode v2.** OpenCode v2 plugin request hooks can rewrite a request but cannot disable TLS verification for it. If this is set, the plugin logs a warning and leaves TLS verification enabled — requests to a self-signed/untrusted `ANTHROPIC_BASE_URL` will fail. |
| `CLAUDE_CODE_VERSION`             | Override the Claude Code version reported to Anthropic. Must be `major.minor.patch` (for example, `2.1.258`). Defaults to the bundled version; a malformed value is logged and ignored. |

Anthropic gates model access on the reported Claude Code version. `CLAUDE_CODE_VERSION` lets you raise it without waiting for a plugin release. The value is read when the plugin loads, so restart OpenCode after changing it.

## How It Works

For Claude Pro/Max authentication, the plugin:

1. Initiates a PKCE OAuth flow against Anthropic's authorization endpoint
2. Exchanges the authorization code for access and refresh tokens
3. Automatically refreshes expired tokens
4. Injects the required OAuth headers and beta flags into API requests
5. Sanitizes the system prompt for compatibility (see below)

### System Prompt Sanitization

The Anthropic API for Max subscriptions has specific requirements for the system prompt to identify as Claude Code. The plugin rewrites the system prompt on each request using an **anchor-based** approach that minimizes what gets changed:

1. **Identity swap** — The OpenCode identity line is removed and replaced with the Claude Code identity.
2. **Paragraph removal by anchor** — Any paragraph containing a known URL anchor (e.g. `github.com/anomalyco/opencode`, `opencode.ai/docs`) is removed entirely. This is resilient to upstream rewording — as long as the anchor URL appears somewhere in the paragraph, the removal works regardless of surrounding text changes.
3. **Inline text replacements** — Short branded strings inside paragraphs we want to keep are replaced (e.g. "OpenCode" → "the assistant" in the professional objectivity section).

Everything else in the system prompt is preserved: tone/style guidance, task management instructions, tool usage policy, environment info, skills, user/project instructions, and file paths containing "opencode". The sanitized system prompt is structured as three blocks in `system[]`: the billing header, the Claude Code identity line, and the remaining system content.

## Development

Verify the package tarball and its exported v2 plugin before publishing:

```bash
bun run check:package
```

This builds the plugin, packs it in a temporary directory, checks the package contents, imports the extracted entrypoint, and verifies that setup registers the Claude Pro/Max OAuth method. It does not use credentials or make model requests.

### Local Testing

Use `bun run dev` to test plugin changes locally without publishing to npm:

```bash
bun run dev
```

This does three things:

1. Builds the plugin
2. Symlinks the build output into `.opencode/plugins/` so OpenCode loads it as a local plugin
3. Starts `tsc --watch` for automatic rebuilds on source changes

After starting the dev script, restart OpenCode v2 (`opencode2`) in this project directory to pick up the local build. Any edits to `src/` will trigger a rebuild — restart OpenCode again to load the new version.

You can confirm the plugin loaded correctly via the OpenCode v2 API:

```bash
opencode2 api get /api/plugin        # should list "ex-machina.anthropic-auth"
opencode2 api get /api/integration   # anthropic should offer a "Claude Pro/Max" OAuth method
```

Ctrl+C stops the watcher and cleans up the symlink. If the process was killed without cleanup (e.g. `kill -9`), you can manually remove the symlink:

```bash
bun run dev:clean
```

> [!NOTE]
> If you have the npm version of this plugin in your global OpenCode config, both will load. The local version takes precedence for auth handling.

### Publishing

This project uses [changesets](https://github.com/changesets/changesets) for versioning and publishing. See the [changeset README](.changeset/README.md) for contributor details.

```bash
bun change          # create a changeset describing your changes
```

Changesets merged to a release branch cause CI to open a release PR; merging that PR publishes to npm. This repository runs two release trains — `main` publishes the v1 line to npm's `latest`, and `v2/main` publishes the v2 line to `next` as `2.x.y-next.N` prereleases.

Maintainers: see [RELEASING.md](RELEASING.md) for the full runbook, including how `main` is synced into `v2/main`.

## License

MIT
